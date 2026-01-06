/**
 * Main App Component for Popilot CLI
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import {
  PostechClient,
  TokenManager,
  TokenStorage,
  SSOAuthenticator,
  SessionService,
  RequestTransformer,
  ToolExecutor,
  ToolParser,
  AVAILABLE_MODELS,
  DEFAULT_CONFIG,
  type Message,
  type StreamChunk,
} from '@popilot/core';
import { Header } from './ui/Header.js';
import { ChatView } from './ui/ChatView.js';
import { InputPrompt } from './ui/InputPrompt.js';
import { Footer } from './ui/Footer.js';
import { ToolConfirmation } from './ui/ToolConfirmation.js';

export interface AppProps {
  model: string;
  workingDir: string;
}

type AppState = 'idle' | 'streaming' | 'confirming' | 'authenticating';

export function App({ model, workingDir }: AppProps) {
  const { exit } = useApp();
  const { setRawMode } = useStdin();

  // State
  const [state, setState] = useState<AppState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentResponse, setCurrentResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(model);
  const [pendingToolCall, setPendingToolCall] = useState<{ name: string; args: Record<string, unknown> } | null>(null);

  // Refs for services (initialized once)
  const servicesRef = useRef<{
    client: PostechClient;
    tokenManager: TokenManager;
    sessionService: SessionService;
    toolExecutor: ToolExecutor;
    transformer: RequestTransformer;
  } | null>(null);

  // Initialize services
  useEffect(() => {
    const tokenStorage = new TokenStorage();
    const authenticator = new SSOAuthenticator({
      ssoUrl: DEFAULT_CONFIG.ssoUrl,
      callbackPattern: DEFAULT_CONFIG.callbackPattern,
    });
    const tokenManager = new TokenManager({
      storage: tokenStorage,
      authenticator,
    });

    const client = new PostechClient({
      apiUrl: DEFAULT_CONFIG.apiUrl,
    });

    const sessionService = new SessionService();
    const toolExecutor = new ToolExecutor({ workspaceDir: workingDir });
    const transformer = new RequestTransformer();

    servicesRef.current = {
      client,
      tokenManager,
      sessionService,
      toolExecutor,
      transformer,
    };

    // Set raw mode for input handling
    setRawMode(true);

    return () => {
      setRawMode(false);
    };
  }, [workingDir, setRawMode]);

  // Handle user input submission
  const handleSubmit = useCallback(async (input: string) => {
    if (state !== 'idle' || !servicesRef.current) return;
    if (!input.trim()) return;

    // Check for slash commands
    if (input.startsWith('/')) {
      handleSlashCommand(input);
      return;
    }

    const { client, tokenManager, sessionService, transformer } = servicesRef.current;

    // Add user message
    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    sessionService.addMessage(userMessage);

    setState('streaming');
    setCurrentResponse('');
    setError(null);

    try {
      // Get valid token
      const token = await tokenManager.getValidToken();

      // Transform messages to POSTECH API format
      const allMessages = [...messages, userMessage];
      const text = transformer.transform(allMessages);

      // Build payload
      const modelConfig = AVAILABLE_MODELS[currentModel];
      // Note: In real implementation, we'd need user info from auth
      const userInfo = {
        userId: 1,
        chatRoomId: 1,
        scenarioId: 'coding-assistant',
        email: 'user@postech.ac.kr',
        deptCode: '00039100',
        sclpstCode: 'C20',
      };

      const payload = PostechClient.buildPayload(
        text,
        userInfo,
        modelConfig,
        sessionService.getCurrentSession(currentModel).threadId
      );

      // Stream response
      let fullResponse = '';
      const toolParser = new ToolParser();

      for await (const chunk of client.streamQuery(token, payload)) {
        if (chunk.type === 'text' && chunk.content) {
          const { output, toolBlock } = toolParser.processChunk(chunk.content);

          if (output) {
            fullResponse += output;
            setCurrentResponse(fullResponse);
          }

          if (toolBlock) {
            // Handle tool call
            const { toolExecutor } = servicesRef.current!;
            if (toolExecutor.isSupported(toolBlock.toolName)) {
              // Check if confirmation needed
              const needsConfirmation = ['run_terminal_command', 'create_new_file', 'edit_file', 'file.applyTextEdits'].includes(toolBlock.toolName);

              if (needsConfirmation && !DEFAULT_CONFIG.autoConfirm) {
                setPendingToolCall({ name: toolBlock.toolName, args: toolBlock.args });
                setState('confirming');
                return;
              }

              // Execute tool
              const result = await toolExecutor.execute(toolBlock.toolName, toolBlock.args);
              fullResponse += `\n\n=== ${toolBlock.toolName} 실행 결과 ===\n${result.result}\n`;
              setCurrentResponse(fullResponse);
            }
          }
        }
      }

      // Flush remaining content
      const remaining = toolParser.flush();
      if (remaining) {
        fullResponse += remaining;
        setCurrentResponse(fullResponse);
      }

      // Add assistant message
      const assistantMessage: Message = { role: 'assistant', content: fullResponse };
      setMessages((prev) => [...prev, assistantMessage]);
      sessionService.addMessage(assistantMessage);

    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState('idle');
      setCurrentResponse('');
    }
  }, [state, messages, currentModel]);

  // Handle slash commands
  const handleSlashCommand = useCallback((input: string) => {
    const [cmd, ...args] = input.slice(1).split(' ');

    switch (cmd.toLowerCase()) {
      case 'quit':
      case 'exit':
      case 'q':
        exit();
        break;

      case 'clear':
        setMessages([]);
        servicesRef.current?.sessionService.clearCurrentSession();
        break;

      case 'model':
        if (args[0] && AVAILABLE_MODELS[args[0]]) {
          setCurrentModel(args[0]);
        } else {
          setError(`사용 가능한 모델: ${Object.keys(AVAILABLE_MODELS).join(', ')}`);
        }
        break;

      case 'help':
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `**Popilot 명령어**
/model <name> - 모델 변경 (${Object.keys(AVAILABLE_MODELS).join(', ')})
/clear - 대화 초기화
/session save - 세션 저장
/session list - 세션 목록
/quit - 종료
/help - 도움말`,
        }]);
        break;

      case 'session':
        handleSessionCommand(args);
        break;

      default:
        setError(`알 수 없는 명령어: /${cmd}. /help로 도움말을 확인하세요.`);
    }
  }, [exit]);

  // Handle session subcommands
  const handleSessionCommand = useCallback(async (args: string[]) => {
    const subCmd = args[0];

    switch (subCmd) {
      case 'save':
        try {
          const path = await servicesRef.current?.sessionService.saveSession();
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `세션이 저장되었습니다: ${path}`,
          }]);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to save session');
        }
        break;

      case 'list':
        try {
          const sessions = await servicesRef.current?.sessionService.listSessions();
          const list = sessions?.map((s) =>
            `- ${s.id}: ${s.model} (${s.messageCount} messages)`
          ).join('\n') || '(no sessions)';
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `**저장된 세션**\n${list}`,
          }]);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to list sessions');
        }
        break;

      case 'load':
        if (args[1]) {
          try {
            const session = await servicesRef.current?.sessionService.loadSession(args[1]);
            if (session) {
              setMessages(session.messages);
              setCurrentModel(session.model);
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load session');
          }
        } else {
          setError('사용법: /session load <session-id>');
        }
        break;

      default:
        setError('사용법: /session [save|list|load <id>]');
    }
  }, []);

  // Handle tool confirmation
  const handleToolConfirm = useCallback(async (confirmed: boolean) => {
    if (!pendingToolCall || !servicesRef.current) {
      setState('idle');
      setPendingToolCall(null);
      return;
    }

    if (confirmed) {
      const { toolExecutor } = servicesRef.current;
      const result = await toolExecutor.execute(pendingToolCall.name, pendingToolCall.args);

      // Add tool result to response
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1];
        if (lastMsg?.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            {
              ...lastMsg,
              content: `${lastMsg.content}\n\n=== ${pendingToolCall.name} 실행 결과 ===\n${result.result}`,
            },
          ];
        }
        return prev;
      });
    } else {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: `도구 실행이 취소되었습니다: ${pendingToolCall.name}`,
      }]);
    }

    setState('idle');
    setPendingToolCall(null);
  }, [pendingToolCall]);

  // Handle keyboard input
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (state === 'streaming') {
        setState('idle');
        setCurrentResponse('');
      } else {
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header model={currentModel} workingDir={workingDir} />

      <Box flexDirection="column" flexGrow={1} marginY={1}>
        <ChatView
          messages={messages}
          currentResponse={currentResponse}
          isStreaming={state === 'streaming'}
        />

        {error && (
          <Box marginTop={1}>
            <Text color="red">Error: {error}</Text>
          </Box>
        )}
      </Box>

      {state === 'confirming' && pendingToolCall && (
        <ToolConfirmation
          toolName={pendingToolCall.name}
          args={pendingToolCall.args}
          onConfirm={handleToolConfirm}
        />
      )}

      {state !== 'confirming' && (
        <InputPrompt
          onSubmit={handleSubmit}
          disabled={state !== 'idle'}
          placeholder={state === 'streaming' ? 'AI가 응답 중...' : '메시지를 입력하세요 (/help)'}
        />
      )}

      <Footer state={state} model={currentModel} />
    </Box>
  );
}
