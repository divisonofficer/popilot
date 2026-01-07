/**
 * Main App Component for Popilot CLI
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import {
  PostechClient,
  PostechClientError,
  TokenManager,
  TokenStorage,
  SSOAuthenticator,
  ApiKeyStorage,
  ApiKeyAuthenticator,
  SessionService,
  RequestTransformer,
  ToolExecutor,
  ToolParser,
  DebugLogger,
  AVAILABLE_MODELS,
  MODEL_ALIASES,
  resolveModelName,
  DEFAULT_CONFIG,
  type Message,
  type ChatRoomInfo,
  type TransformerConfig,
  type AuthMode,
} from '@popilot/core';
import { Header } from './ui/Header.js';
import { ChatView } from './ui/ChatView.js';
import { InputPrompt } from './ui/InputPrompt.js';
import { Footer } from './ui/Footer.js';
import { ToolConfirmation } from './ui/ToolConfirmation.js';

export interface AppProps {
  model: string;
  workingDir: string;
  transformerConfig?: TransformerConfig;
}

type AppState = 'idle' | 'streaming' | 'confirming' | 'authenticating' | 'executing_tool';

/**
 * User profile data from POSTECH API.
 */
interface UserProfile {
  authUsersId: number;
  name: string;
  email: string;
  authServerUsername: string;
  deptCode: string;
  sclpstCode: string;
  userName: string;
}

/**
 * Pending loop state for tool confirmation flow.
 * Stores the state needed to resume the agentic loop after user confirms/denies a tool.
 */
interface PendingLoopState {
  iteration: number;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  currentToolIndex: number;
  conversationMessages: Message[];
  fullDisplayResponse: string;
  credential: string;
  authMode: AuthMode;
  a2Model: 'gemini' | 'gpt' | 'claude';
  initResult: {
    userInfo: {
      userId: number;
      chatRoomId: number;
      scenarioId: string;
      email: string;
      deptCode: string;
      sclpstCode: string;
      userName?: string;
      name?: string;
    };
  } | null;
}

/**
 * Default AI agent ID for chat (Robi GPT Dev).
 */
const DEFAULT_AI_AGENT_ID = 9;
const DEFAULT_SCENARIO_ID = 'robi-gpt-dev:workflow_wKstTOFnV25Ictc';
const MAX_AGENT_ITERATIONS = 50;  // Increased for complex tasks (A2 API has generous limits)
const MAX_ERROR_RETRIES = 3;

/**
 * Summarize tool output for UI display (don't show full file contents).
 */
function summarizeToolOutput(toolName: string, args: Record<string, unknown>, result: string): string {
  const filepath = String(args.filepath || args.dirpath || '');

  switch (toolName) {
    case 'read_file':
    case 'file.read': {
      // Extract line count from result
      const linesMatch = result.match(/Lines: (\d+)/);
      const lines = linesMatch ? linesMatch[1] : '?';
      return `📄 파일 읽기: ${filepath} (${lines}줄)`;
    }

    case 'list_directory': {
      const entries = result.split('\n').filter(l => l.trim()).length;
      return `📁 디렉토리 조회: ${filepath || '.'} (${entries}개 항목)`;
    }

    case 'create_new_file':
      return `✨ 파일 생성: ${filepath}`;

    case 'edit_file':
      return `✏️ 파일 수정: ${filepath}`;

    case 'file.applyTextEdits': {
      const edits = args.edits;
      const editCount = Array.isArray(edits) ? edits.length : 1;
      return `✏️ 파일 부분 수정: ${filepath} (${editCount}개 편집)`;
    }

    case 'file.search': {
      const matchCount = result.match(/Found (\d+) matches/);
      const matches = matchCount ? matchCount[1] : '0';
      return `🔍 파일 검색: ${filepath} (${matches}개 일치)`;
    }

    case 'run_terminal_command': {
      const command = String(args.command || '');
      const shortCmd = command.length > 50 ? command.slice(0, 50) + '...' : command;
      return `💻 명령 실행: ${shortCmd}`;
    }

    case 'find_files':
    case 'file.find': {
      const pattern = String(args.pattern || args.name || '*');
      const fileCount = result.match(/Found (\d+) file/);
      const count = fileCount ? fileCount[1] : '?';
      return `🔍 파일 검색: "${pattern}" (${count}개 파일)`;
    }

    case 'tree': {
      const dirpath = String(args.dirpath || '.');
      return `🌲 트리 조회: ${dirpath}`;
    }

    default:
      return `🔧 ${toolName} 실행 완료`;
  }
}

/**
 * Format tool name with key parameters for display in footer.
 */
function formatToolDisplay(toolName: string, args: Record<string, unknown>): string {
  const filepath = String(args.filepath || args.dirpath || '');
  const shortPath = filepath.length > 40 ? '...' + filepath.slice(-37) : filepath;

  switch (toolName) {
    case 'read_file':
    case 'file.read':
      return `file.read (${shortPath || 'file'})`;

    case 'list_directory':
      return `list_directory (${shortPath || '.'})`;

    case 'tree':
      return `tree (${shortPath || '.'})`;

    case 'create_new_file':
      return `create_new_file (${shortPath})`;

    case 'edit_file':
      return `edit_file (${shortPath})`;

    case 'file.applyTextEdits':
      return `file.applyTextEdits (${shortPath})`;

    case 'file.search': {
      const pattern = String(args.pattern || '');
      return `file.search (${shortPath}, "${pattern.slice(0, 20)}")`;
    }

    case 'find_files': {
      const pattern = String(args.pattern || args.name || '');
      return `find_files (${pattern})`;
    }

    case 'run_terminal_command': {
      const command = String(args.command || '');
      const shortCmd = command.length > 30 ? command.slice(0, 30) + '...' : command;
      return `run_terminal_command (${shortCmd})`;
    }

    default:
      return toolName;
  }
}

export function App({ model, workingDir, transformerConfig }: AppProps) {
  const { exit } = useApp();
  const { setRawMode } = useStdin();

  // State
  const [state, setState] = useState<AppState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentResponse, setCurrentResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState(model);
  const [pendingToolCall, setPendingToolCall] = useState<{ name: string; args: Record<string, unknown> } | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [chatRoomInfo, setChatRoomInfo] = useState<ChatRoomInfo | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [initializingChat, setInitializingChat] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [pendingResume, setPendingResume] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('apikey');

  // Refs for services (initialized once)
  const servicesRef = useRef<{
    client: PostechClient;
    tokenManager: TokenManager;
    apiKeyStorage: ApiKeyStorage;
    apiKeyAuthenticator: ApiKeyAuthenticator;
    sessionService: SessionService;
    toolExecutor: ToolExecutor;
    transformer: RequestTransformer;
    logger: DebugLogger;
  } | null>(null);

  // Ref for pending loop state during tool confirmation
  const pendingLoopStateRef = useRef<PendingLoopState | null>(null);

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

    // API Key authentication
    const apiKeyStorage = new ApiKeyStorage();
    const apiKeyAuthenticator = new ApiKeyAuthenticator({
      storage: apiKeyStorage,
    });

    const client = new PostechClient({
      apiUrl: DEFAULT_CONFIG.apiUrl,
    });

    const sessionService = new SessionService();
    const toolExecutor = new ToolExecutor({ workspaceDir: workingDir });

    // Initialize transformer with model-specific settings
    const initialModelConfig = AVAILABLE_MODELS[model];
    const transformer = new RequestTransformer({
      ...transformerConfig,
      modelProvider: initialModelConfig?.provider ?? 'anthropic',
    });
    const logger = new DebugLogger(workingDir, true);

    console.log(`📁 Debug logs: ${logger.getLogDir()}`);

    // Log transformer config if custom values are set
    const config = transformer.getConfig();
    console.log(`📊 Transformer config: hardLimit=${config.hardLimit}, maxTextLength=${config.maxTextLength}, maxToolOutput=${config.maxToolOutputLength}, keepRecent=${config.keepRecentMessages}, provider=${config.modelProvider}`);

    servicesRef.current = {
      client,
      tokenManager,
      apiKeyStorage,
      apiKeyAuthenticator,
      sessionService,
      toolExecutor,
      transformer,
      logger,
    };

    // Check authentication status on startup
    setIsAuthenticated(tokenManager.hasValidToken());

    // Set raw mode for input handling
    setRawMode(true);

    return () => {
      setRawMode(false);
    };
  }, [workingDir, setRawMode]);

  /**
   * Initialize chat room - fetches user profile and AI agent info.
   * Returns user info needed for API requests.
   */
  const initializeChatRoom = useCallback(async (token: string): Promise<{
    userInfo: {
      userId: number;
      chatRoomId: number;
      scenarioId: string;
      email: string;
      deptCode: string;
      sclpstCode: string;
      userName?: string;
      name?: string;
    };
  } | null> => {
    if (!servicesRef.current) return null;
    const { client } = servicesRef.current;

    setInitializingChat(true);
    try {
      // 1. Get user profile if not already fetched
      let profile = userProfile;
      if (!profile) {
        console.log('Fetching user profile...');
        const profileData = await client.getUserProfile(token);
        profile = {
          authUsersId: profileData.authUsersId,
          name: profileData.name,
          email: profileData.email,
          authServerUsername: profileData.authServerUsername,
          deptCode: profileData.attributes.dept_code?.[0] || '00039100',
          sclpstCode: profileData.attributes.sclpst_code?.[0] || 'C20',
          userName: profileData.attributes.user_id?.[0] || '',
        };
        setUserProfile(profile);
        console.log(`User: ${profile.name} (${profile.email})`);
      }

      // 2. Get AI agent info to get chatRoomId
      let roomInfo = chatRoomInfo;
      if (!roomInfo) {
        console.log('Fetching AI agents...');
        const agents = await client.getAIAgents(token);
        const targetAgent = agents.find(a => a.id === DEFAULT_AI_AGENT_ID);

        if (!targetAgent) {
          throw new Error(`AI Agent with ID ${DEFAULT_AI_AGENT_ID} not found`);
        }

        // Use chatRoomId from AI agent and authUsersId from user profile
        roomInfo = {
          chatRoomsId: targetAgent.chatRoomId,
          usersId: profile.authUsersId,
        };
        setChatRoomInfo(roomInfo);
        console.log(`Using chat room: ${roomInfo.chatRoomsId} (Agent: ${targetAgent.name})`);
      }

      return {
        userInfo: {
          userId: roomInfo.usersId,
          chatRoomId: roomInfo.chatRoomsId,
          scenarioId: DEFAULT_SCENARIO_ID,
          email: profile.email,
          deptCode: profile.deptCode,
          sclpstCode: profile.sclpstCode,
          userName: profile.userName,
          name: profile.name,
        },
      };
    } catch (err) {
      console.error('Failed to initialize chat room:', err);
      throw err;
    } finally {
      setInitializingChat(false);
    }
  }, [userProfile, chatRoomInfo]);

  // Handle user input submission with agentic loop
  const handleSubmit = useCallback(async (input: string) => {
    if (state !== 'idle' || !servicesRef.current) return;
    if (!input.trim()) return;

    // Check for slash commands
    if (input.startsWith('/')) {
      handleSlashCommand(input);
      return;
    }

    const { client, tokenManager, apiKeyAuthenticator, sessionService, transformer, toolExecutor, logger } = servicesRef.current;

    // Ensure session exists
    sessionService.getCurrentSession(currentModel);

    // Add user message
    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    sessionService.addMessage(userMessage);

    setState('streaming');
    setCurrentResponse('');
    setError(null);

    // Determine credential and API mode
    const modelConfig = AVAILABLE_MODELS[currentModel];
    let a2Model: 'gemini' | 'gpt' | 'claude' = 'gemini';
    if (modelConfig.provider === 'azure') a2Model = 'gpt';
    else if (modelConfig.provider === 'anthropic') a2Model = 'claude';
    else if (modelConfig.provider === 'google') a2Model = 'gemini';

    // Full agentic loop with tools (both API key and SSO modes)
    // Track iteration for error logging
    let iteration = 0;
    let loopEndReason: 'completed' | 'max_iterations' | 'error' | 'unexpected' | 'confirming' = 'unexpected';

    // Filter out tool block markers from display (tool syntax not for users)
    const filterOutput = (text: string): string => {
      return text
        // Remove tool block markers
        .replace(/```tool\s*/g, '')
        .replace(/```\s*$/g, '')
        .replace(/TOOL_NAME:\s*\S+\s*\n?/g, '')
        .replace(/BEGIN_ARG:\s*\S+\s*\n?/g, '')
        .replace(/END_ARG\s*/g, '')
        // Remove API-appended HTML tool comments (A2 API adds these)
        .replace(/<!--\s*tools?:\s*\w*\s*-->/gi, '')
        // Clean up multiple newlines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    try {
      // Get credential based on auth mode
      let credential: string;
      let initResult: { userInfo: { userId: number; chatRoomId: number; scenarioId: string; email: string; deptCode: string; sclpstCode: string; userName?: string; name?: string; } } | null = null;

      if (authMode === 'apikey') {
        credential = await apiKeyAuthenticator.getApiKey();
        setIsAuthenticated(true);
      } else {
        // SSO mode - get token and initialize chat room
        credential = await tokenManager.getValidToken();
        setIsAuthenticated(true);
        initResult = await initializeChatRoom(credential);
        if (!initResult) {
          throw new Error('Failed to initialize chat room');
        }
      }

      // Agentic loop - continue until no more tool calls or max iterations
      let conversationMessages = [...messages, userMessage];
      let errorRetryCount = 0;
      let fullDisplayResponse = ''; // What we show to user (summarized)

      while (iteration < MAX_AGENT_ITERATIONS) {
        iteration++;
        logger.logIteration(iteration, 'start', `msgCount=${conversationMessages.length}`);

        // Log conversation state
        logger.logConversation(iteration, conversationMessages);

        // Transform messages to POSTECH API format (includes system prompt with tools)
        const text = transformer.transform(conversationMessages);

        // Stream response - just accumulate, don't parse during streaming
        setState('streaming');
        let rawResponse = '';

        if (authMode === 'apikey') {
          // A2 API - simpler payload
          for await (const chunk of client.streamQueryA2(credential, text, a2Model, false)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse = chunk.content; // A2 returns full response, not incremental
              const displayText = filterOutput(rawResponse);
              setCurrentResponse(fullDisplayResponse + displayText);
            }
          }
        } else {
          // SSO API - full payload with chat room
          const payload = PostechClient.buildPayload(
            text,
            initResult!.userInfo,
            modelConfig,
            sessionService.getCurrentSession(currentModel).threadId
          );
          logger.logRequest(iteration, payload);

          for await (const chunk of client.streamQuery(credential, payload)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse += chunk.content;
              const displayText = filterOutput(rawResponse);
              setCurrentResponse(fullDisplayResponse + displayText);
            }
            // Save threadId for SSO mode
            if (chunk.threadId && !sessionService.getCurrentSession(currentModel).threadId) {
              sessionService.setThreadId(chunk.threadId);
            }
          }
        }

        // Log raw response
        logger.logResponse(iteration, rawResponse);

        // Check for API error responses - don't add to conversation
        const isErrorResponse = rawResponse.includes('failed to parse stringified json') ||
          rawResponse.includes('Unexpected token') ||
          rawResponse.includes('Internal Server Error') ||
          (rawResponse.trim().startsWith('"') && rawResponse.includes('error'));

        if (isErrorResponse) {
          errorRetryCount++;
          logger.logError(iteration, `API Error in response (retry ${errorRetryCount}): ${rawResponse.slice(0, 200)}`);

          if (errorRetryCount >= MAX_ERROR_RETRIES) {
            // Max retries reached - show error and break
            fullDisplayResponse += `\n[x] API 오류가 계속 발생합니다. 대화를 새로 시작해주세요.\n`;
            setCurrentResponse(fullDisplayResponse);
            const errorMessage: Message = {
              role: 'assistant',
              content: '[API 오류로 인해 요청을 처리할 수 없습니다. /clear로 대화를 초기화해주세요.]',
            };
            setMessages((prev) => [...prev, errorMessage]);
            break;
          }

          fullDisplayResponse += `\n[!] API 오류 발생, 재시도 중... (${errorRetryCount}/${MAX_ERROR_RETRIES})\n`;
          setCurrentResponse(fullDisplayResponse);
          // Wait a bit and retry this iteration
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        // Reset error retry count on successful response
        errorRetryCount = 0;

        // Check for empty response
        if (!rawResponse.trim()) {
          logger.logIteration(iteration, 'aborted', 'empty_response');
          logger.logError(iteration, 'Empty response received from API');
          fullDisplayResponse += '\n[!] 빈 응답을 받았습니다. 재시도 중...\n';
          setCurrentResponse(fullDisplayResponse);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        // After streaming complete, parse tool calls from full response
        const toolCalls = ToolParser.extractAllToolCalls(rawResponse);
        const cleanResponse = ToolParser.removeToolBlocks(rawResponse);

        // Check for incomplete/malformed tool call attempts
        const looksLikeToolAttempt = /tool-\w+|TOOL_NAME:|```tool/i.test(rawResponse);

        // Check for other malformed attempts
        const hasValidContent = cleanResponse.trim().length > 20;
        if (toolCalls.length === 0 && looksLikeToolAttempt && !hasValidContent) {
          logger.logIteration(iteration, 'aborted', 'malformed_tool_response');
          logger.logError(iteration, `Malformed tool response: ${rawResponse.slice(0, 200)}`);
          fullDisplayResponse += '\n[!] 불완전한 도구 응답. 재시도 중...\n';
          setCurrentResponse(fullDisplayResponse);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        // Log parsed tool calls
        logger.logToolCalls(iteration, toolCalls);

        if (toolCalls.length > 0) {
          // Add assistant message with tool calls to conversation history FIRST
          const assistantWithTools: Message = {
            role: 'assistant',
            content: cleanResponse || `[도구 ${toolCalls.length}개 호출]`,
          };
          conversationMessages.push(assistantWithTools);

          // Execute all tool calls (using index to track position for resumption)
          for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
            const toolCall = toolCalls[toolIndex];

            if (!toolExecutor.isSupported(toolCall.toolName)) {
              // Log and show unsupported tool
              logger.logError(iteration, `Unsupported tool: ${toolCall.toolName}`);
              fullDisplayResponse += `⚠️ 미지원 도구: ${toolCall.toolName}\n`;
              setCurrentResponse(fullDisplayResponse);

              // Add skip message for unsupported tools
              const skipMessage: Message = {
                role: 'tool',
                content: `[${toolCall.toolName}] 지원하지 않는 도구입니다. 지원 도구: file.read, file.search, file.applyTextEdits, run_terminal_command, list_directory, tree, create_new_file, edit_file`,
              };
              conversationMessages.push(skipMessage);
              continue;
            }

            // Check if confirmation needed
            const needsConfirmation = ['run_terminal_command', 'create_new_file', 'edit_file', 'file.applyTextEdits'].includes(toolCall.toolName);

            if (needsConfirmation && !autoConfirm) {
              // Save loop state for resumption after confirmation
              pendingLoopStateRef.current = {
                iteration,
                toolCalls,
                currentToolIndex: toolIndex,
                conversationMessages: [...conversationMessages],
                fullDisplayResponse,
                credential,
                authMode,
                a2Model,
                initResult,
              };
              setPendingToolCall({ name: toolCall.toolName, args: toolCall.args });
              setState('confirming');
              loopEndReason = 'confirming'; // Prevent finally from resetting state
              return;
            }

            // Execute tool
            setState('executing_tool');
            setCurrentTool(formatToolDisplay(toolCall.toolName, toolCall.args));

            const result = await toolExecutor.execute(toolCall.toolName, toolCall.args);

            // Log tool result
            logger.logToolResult(iteration, toolCall.toolName, toolCall.args, result.result);

            // Add summarized output to display response
            const summary = summarizeToolOutput(toolCall.toolName, toolCall.args, result.result);
            fullDisplayResponse += summary + '\n';
            setCurrentResponse(fullDisplayResponse);

            // Add full tool result to conversation for model context
            const toolResultMessage: Message = {
              role: 'tool',
              content: `[${toolCall.toolName} 결과]\n${result.result}`,
            };
            conversationMessages.push(toolResultMessage);

            setCurrentTool(null);
          }

          // Continue loop to get model's response with tool results
          setState('streaming');
        } else {
          // No tool calls - we're done
          logger.logIteration(iteration, 'end', 'no_tool_calls');
          loopEndReason = 'completed';

          fullDisplayResponse += filterOutput(cleanResponse);
          setCurrentResponse(fullDisplayResponse);

          // Add final assistant message
          const assistantMessage: Message = { role: 'assistant', content: fullDisplayResponse };
          setMessages((prev) => [...prev, assistantMessage]);
          sessionService.addMessage(assistantMessage);
          logger.logLoopEnd(loopEndReason, iteration, `response_length=${fullDisplayResponse.length}`);
          break;
        }
      }

      if (iteration >= MAX_AGENT_ITERATIONS) {
        loopEndReason = 'max_iterations';
        fullDisplayResponse += '\n\n[!] 최대 반복 횟수에 도달했습니다.';
        setCurrentResponse(fullDisplayResponse);
        const assistantMessage: Message = { role: 'assistant', content: fullDisplayResponse };
        setMessages((prev) => [...prev, assistantMessage]);
        sessionService.addMessage(assistantMessage);
        logger.logLoopEnd(loopEndReason, iteration);
      }

    } catch (err) {
      // Log error
      loopEndReason = 'error';
      logger.logError(0, err instanceof Error ? err : String(err));
      logger.logLoopEnd(loopEndReason, iteration, err instanceof Error ? err.message : String(err));

      if (err instanceof PostechClientError) {
        const detailedLog = err.getDetailedLog();
        console.error('\n' + detailedLog);
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `**API 오류 발생**\n\`\`\`\n${detailedLog}\n\`\`\``,
        }]);
        setError(err.message);
        if (err.statusCode === 401) {
          setIsAuthenticated(false);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Don't reset state if waiting for tool confirmation
      if (loopEndReason === 'confirming') {
        return; // User needs to confirm/deny tool first
      }

      // Log unexpected termination if loop didn't complete normally
      if (loopEndReason === 'unexpected' && iteration > 0) {
        logger.logLoopEnd('unexpected', iteration, 'Loop terminated without proper completion');
      }
      setState('idle');
      setCurrentResponse('');
      setCurrentTool(null);
    }
  }, [state, messages, currentModel, initializeChatRoom, autoConfirm]);

  // Handle slash commands
  const handleSlashCommand = useCallback((input: string) => {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0] || '';
    const args = parts.slice(1);

    switch (cmd.toLowerCase()) {
      case 'gpt': {
        // /gpt 명령어는 /model gpt로 동작
        handleSlashCommand('/model gpt');
        break;
      }
      case 'quit':
      case 'exit':
      case 'q':
        exit();
        break;

      case 'clear':
        setMessages([]);
        servicesRef.current?.sessionService.clearCurrentSession();
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: '[SYSTEM] 대화가 초기화되었습니다. (Thread ID 리셋)',
        }]);
        break;

      case 'thread': {
        const session = servicesRef.current?.sessionService.getCurrentSession(currentModel);
        const threadId = session?.threadId;
        const msgCount = messages.length;
        if (threadId) {
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] 현재 Thread: ${threadId} (메시지 ${msgCount}개)`,
          }]);
        } else {
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: '[SYSTEM] Thread 미생성. 첫 메시지 전송 시 생성됩니다.',
          }]);
        }
        break;
      }

      case 'model':
        if (args[0]) {
          const resolvedModel = resolveModelName(args[0]);
          if (resolvedModel) {
            setCurrentModel(resolvedModel);
            // Update transformer config for model-specific settings
            const modelConfig = AVAILABLE_MODELS[resolvedModel];
            servicesRef.current?.transformer.updateConfig({
              modelProvider: modelConfig.provider,
            });
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 모델 변경: ${modelConfig.modelName}`,
            }]);
          } else {
            const aliases = Object.keys(MODEL_ALIASES).join(', ');
            const models = Object.keys(AVAILABLE_MODELS).join(', ');
            setError(`사용 가능한 모델: ${aliases} 또는 ${models}`);
          }
        } else {
          const aliases = Object.keys(MODEL_ALIASES).join(', ');
          setError(`사용법: /model <name> (${aliases})`);
        }
        break;

      case 'help':
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `[SYSTEM] 명령어: /model, /clear, /thread, /retry, /config, /autoconfirm, /session, /api, /sso, /auth, /logout, /quit`,
        }]);
        break;

      case 'autoconfirm':
      case 'auto': {
        const newValue = !autoConfirm;
        setAutoConfirm(newValue);
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `[SYSTEM] 자동승인: ${newValue ? 'ON' : 'OFF'}`,
        }]);
        break;
      }

      case 'config': {
        // /config set <param> <value> or /config (show current)
        if (args[0] === 'set' && args[1] && args[2]) {
          const param = args[1].toLowerCase();
          const value = parseInt(args[2], 10);

          if (isNaN(value)) {
            setError(`잘못된 값: ${args[2]} (숫자를 입력하세요)`);
            break;
          }

          const paramMap: Record<string, string> = {
            'hardlimit': 'hardLimit',
            'hard-limit': 'hardLimit',
            'maxtextlength': 'maxTextLength',
            'max-text-length': 'maxTextLength',
            'maxtooloutput': 'maxToolOutputLength',
            'max-tool-output': 'maxToolOutputLength',
            'maxtooloutputlength': 'maxToolOutputLength',
            'keeprecent': 'keepRecentMessages',
            'keep-recent': 'keepRecentMessages',
            'keeprecentmessages': 'keepRecentMessages',
          };

          const configKey = paramMap[param];
          if (!configKey) {
            setError(`알 수 없는 파라미터: ${param}\n사용 가능: hardLimit, maxTextLength, maxToolOutput, keepRecent`);
            break;
          }

          servicesRef.current?.transformer.updateConfig({ [configKey]: value });
          const newConfig = servicesRef.current?.transformer.getConfig();
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] ${configKey}=${value} (hardLimit=${newConfig?.hardLimit}, maxText=${newConfig?.maxTextLength})`,
          }]);
        } else {
          const config = servicesRef.current?.transformer.getConfig();
          if (config) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 설정: hardLimit=${config.hardLimit}, maxText=${config.maxTextLength}, toolOutput=${config.maxToolOutputLength}, keepRecent=${config.keepRecentMessages}`,
            }]);
          }
        }
        break;
      }

      case 'logout':
        if (servicesRef.current) {
          servicesRef.current.tokenManager.clearToken();
          setIsAuthenticated(false);
          setChatRoomInfo(null);
          setUserProfile(null);
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: '[SYSTEM] 로그아웃 완료',
          }]);
        }
        break;

      case 'session':
        handleSessionCommand(args);
        break;

      case 'api': {
        // /api - switch to API key mode
        // /api set <key> - save API key
        // /api clear - clear saved API key
        if (!args[0]) {
          // Switch to API key mode
          setAuthMode('apikey');
          servicesRef.current?.client.setAuthMode('apikey');
          setChatRoomInfo(null); // Clear chat room (not needed for API key mode)
          setUserProfile(null);
          const hasKey = servicesRef.current?.apiKeyAuthenticator.hasApiKey();
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] API 키 모드로 전환되었습니다. ${hasKey ? '(저장된 키 사용)' : '(키 미설정 - /api set <key>)'}`,
          }]);
        } else if (args[0] === 'set' && args[1]) {
          const key = args.slice(1).join(' ').trim();
          servicesRef.current?.apiKeyStorage.saveApiKey(key);
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: '[SYSTEM] API 키가 저장되었습니다.',
          }]);
        } else if (args[0] === 'clear') {
          servicesRef.current?.apiKeyStorage.clearApiKey();
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: '[SYSTEM] 저장된 API 키가 삭제되었습니다.',
          }]);
        } else {
          setError('사용법: /api, /api set <key>, /api clear');
        }
        break;
      }

      case 'sso': {
        // Switch back to SSO mode
        setAuthMode('sso');
        servicesRef.current?.client.setAuthMode('sso');
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: '[SYSTEM] SSO 모드로 전환되었습니다.',
        }]);
        break;
      }

      case 'auth': {
        // Show current auth status
        const mode = authMode;
        const services = servicesRef.current;
        let status = `모드: ${mode.toUpperCase()}`;

        if (mode === 'sso') {
          const hasToken = services?.tokenManager.hasValidToken();
          status += hasToken ? ' (인증됨)' : ' (미인증)';
        } else {
          const keySource = services?.apiKeyAuthenticator.getKeySource();
          status += keySource === 'env' ? ' (환경변수)' : keySource === 'stored' ? ' (저장됨)' : ' (미설정)';
        }

        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: `[SYSTEM] 인증 상태: ${status}`,
        }]);
        break;
      }

      case 'retry':
      case 'regen': {
        // Find last user message
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            lastUserIdx = i;
            break;
          }
        }

        if (lastUserIdx === -1) {
          setError('재시도할 메시지가 없습니다.');
          break;
        }

        const lastUserContent = messages[lastUserIdx].content;
        const lastInput = typeof lastUserContent === 'string' ? lastUserContent : '';

        if (!lastInput) {
          setError('재시도할 메시지가 없습니다.');
          break;
        }

        // Remove messages from the last user message (inclusive) - will be re-added by handleSubmit
        const newMessages = messages.slice(0, lastUserIdx);
        setMessages(newMessages);

        // Clear and rebuild session
        if (servicesRef.current) {
          servicesRef.current.sessionService.clearCurrentSession();
          // Create a new session before adding messages
          servicesRef.current.sessionService.getCurrentSession(currentModel);
          for (const msg of newMessages) {
            servicesRef.current.sessionService.addMessage(msg);
          }
        }

        // Set pending retry to trigger useEffect
        setPendingRetry(lastInput);
        break;
      }

      default:
        setError(`알 수 없는 명령어: /${cmd}.\n\n[Popilot CLI 도움말]\n\n- /help : 모든 명령어와 사용법 안내를 출력합니다.\n- /exit : 프로그램을 종료합니다.\n- /clear : 대화 내용을 초기화합니다.\n- /model <모델명> : 사용할 AI 모델을 변경합니다.\n- /config : 현재 설정을 확인합니다.\n\n명령어는 슬래시(/)로 시작하며, 자세한 사용법은 공식 문서를 참고하세요!\n\n예시) /model gpt-4o\n\n더 궁금한 점이 있으면 언제든 /help를 입력하세요. 😊`);
    }
  }, [exit, messages, autoConfirm, authMode]);

  // Handle session subcommands
  const handleSessionCommand = useCallback(async (args: string[]) => {
    const subCmd = args[0];

    switch (subCmd) {
      case 'save':
        try {
          const path = await servicesRef.current?.sessionService.saveSession();
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] 세션 저장: ${path}`,
          }]);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to save session');
        }
        break;

      case 'list':
        try {
          const sessions = await servicesRef.current?.sessionService.listSessions();
          const count = sessions?.length || 0;
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] 저장된 세션: ${count}개`,
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

  // Handle tool confirmation - execute tool and prepare for loop resumption
  const handleToolConfirm = useCallback(async (confirmed: boolean) => {
    if (!pendingToolCall || !servicesRef.current || !pendingLoopStateRef.current) {
      setState('idle');
      setPendingToolCall(null);
      pendingLoopStateRef.current = null;
      return;
    }

    const loopState = pendingLoopStateRef.current;
    const { toolExecutor, logger } = servicesRef.current;

    if (confirmed) {
      // Execute the confirmed tool
      setState('executing_tool');
      setCurrentTool(formatToolDisplay(pendingToolCall.name, pendingToolCall.args));

      const result = await toolExecutor.execute(pendingToolCall.name, pendingToolCall.args);

      // Log tool result
      logger.logToolResult(loopState.iteration, pendingToolCall.name, pendingToolCall.args, result.result);

      // Add summarized output to display response
      const summary = summarizeToolOutput(pendingToolCall.name, pendingToolCall.args, result.result);
      loopState.fullDisplayResponse += summary + '\n';
      setCurrentResponse(loopState.fullDisplayResponse);

      // Add full tool result to conversation for model context
      const toolResultMessage: Message = {
        role: 'tool',
        content: `[${pendingToolCall.name} 결과]\n${result.result}`,
      };
      loopState.conversationMessages.push(toolResultMessage);

      setCurrentTool(null);
    } else {
      // Tool denied - add skip message to conversation
      const skipMessage: Message = {
        role: 'tool',
        content: `[${pendingToolCall.name}] 사용자가 실행을 거부했습니다.`,
      };
      loopState.conversationMessages.push(skipMessage);
      loopState.fullDisplayResponse += `⛔ ${pendingToolCall.name} 실행 취소됨\n`;
      setCurrentResponse(loopState.fullDisplayResponse);
    }

    // Move to next tool
    loopState.currentToolIndex++;

    // Clear pending tool call and trigger loop resumption
    setPendingToolCall(null);
    setPendingResume(true);
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

  // Handle pending retry - useEffect to call handleSubmit after state updates
  useEffect(() => {
    if (pendingRetry !== null && state === 'idle') {
      const input = pendingRetry;
      setPendingRetry(null);
      // Use setTimeout to ensure state has fully updated
      setTimeout(() => {
        handleSubmit(input);
      }, 50);
    }
  }, [pendingRetry, state, handleSubmit]);

  // Resume agentic loop after tool confirmation
  const resumeAgenticLoop = useCallback(async () => {
    if (!pendingLoopStateRef.current || !servicesRef.current) {
      setState('idle');
      return;
    }

    const loopState = pendingLoopStateRef.current;
    const { client, sessionService, transformer, toolExecutor, logger } = servicesRef.current;
    const modelConfig = AVAILABLE_MODELS[currentModel];

    // Filter output helper
    // Filter out tool block markers from display
    const filterOutput = (text: string): string => {
      return text
        .replace(/```tool\s*/g, '')
        .replace(/```\s*$/g, '')
        .replace(/TOOL_NAME:\s*\S+\s*\n?/g, '')
        .replace(/BEGIN_ARG:\s*\S+\s*\n?/g, '')
        .replace(/END_ARG\s*/g, '')
        // Remove API-appended HTML tool comments (A2 API adds these)
        .replace(/<!--\s*tools?:\s*\w*\s*-->/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    let { iteration, toolCalls, currentToolIndex, conversationMessages, fullDisplayResponse, credential, authMode: loopAuthMode, a2Model: loopA2Model, initResult } = loopState;

    // Track why the loop ended to prevent finally from resetting state incorrectly
    let loopEndReason: 'completed' | 'max_iterations' | 'error' | 'unexpected' | 'confirming' = 'unexpected';

    try {
      // Continue processing remaining tools from the current iteration
      for (let toolIndex = currentToolIndex; toolIndex < toolCalls.length; toolIndex++) {
        const toolCall = toolCalls[toolIndex];

        if (!toolExecutor.isSupported(toolCall.toolName)) {
          // Log and show unsupported tool
          logger.logError(iteration, `Unsupported tool: ${toolCall.toolName}`);
          fullDisplayResponse += `⚠️ 미지원 도구: ${toolCall.toolName}\n`;
          setCurrentResponse(fullDisplayResponse);

          const skipMessage: Message = {
            role: 'tool',
            content: `[${toolCall.toolName}] 지원하지 않는 도구입니다. 지원 도구: file.read, file.search, file.applyTextEdits, run_terminal_command, list_directory, tree, create_new_file, edit_file`,
          };
          conversationMessages.push(skipMessage);
          continue;
        }

        // Check if confirmation needed
        const needsConfirmation = ['run_terminal_command', 'create_new_file', 'edit_file', 'file.applyTextEdits'].includes(toolCall.toolName);

        if (needsConfirmation && !autoConfirm) {
          // Save updated loop state and wait for confirmation
          pendingLoopStateRef.current = {
            ...loopState,
            currentToolIndex: toolIndex,
            conversationMessages: [...conversationMessages],
            fullDisplayResponse,
          };
          setPendingToolCall({ name: toolCall.toolName, args: toolCall.args });
          setState('confirming');
          loopEndReason = 'confirming'; // Prevent finally from resetting state
          return;
        }

        // Execute tool
        setState('executing_tool');
        setCurrentTool(formatToolDisplay(toolCall.toolName, toolCall.args));

        const result = await toolExecutor.execute(toolCall.toolName, toolCall.args);

        // Log tool result
        logger.logToolResult(iteration, toolCall.toolName, toolCall.args, result.result);

        // Add summarized output to display response
        const summary = summarizeToolOutput(toolCall.toolName, toolCall.args, result.result);
        fullDisplayResponse += summary + '\n';
        setCurrentResponse(fullDisplayResponse);

        // Add full tool result to conversation for model context
        const toolResultMessage: Message = {
          role: 'tool',
          content: `[${toolCall.toolName} 결과]\n${result.result}`,
        };
        conversationMessages.push(toolResultMessage);

        setCurrentTool(null);
      }

      // All tools from current iteration processed, continue agentic loop
      while (iteration < MAX_AGENT_ITERATIONS) {
        iteration++;

        // Log conversation state
        logger.logConversation(iteration, conversationMessages);

        // Transform messages to POSTECH API format
        const text = transformer.transform(conversationMessages);

        // Stream response
        setState('streaming');
        let rawResponse = '';

        if (loopAuthMode === 'apikey') {
          // A2 API
          for await (const chunk of client.streamQueryA2(credential, text, loopA2Model, false)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse = chunk.content;
              const displayText = filterOutput(rawResponse);
              setCurrentResponse(fullDisplayResponse + displayText);
            }
          }
        } else {
          // SSO API
          const payload = PostechClient.buildPayload(
            text,
            initResult!.userInfo,
            modelConfig,
            sessionService.getCurrentSession(currentModel).threadId
          );
          logger.logRequest(iteration, payload);

          for await (const chunk of client.streamQuery(credential, payload)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse += chunk.content;
              const displayText = filterOutput(rawResponse);
              setCurrentResponse(fullDisplayResponse + displayText);
            }
            if (chunk.threadId && !sessionService.getCurrentSession(currentModel).threadId) {
              sessionService.setThreadId(chunk.threadId);
            }
          }
        }

        // Log raw response
        logger.logResponse(iteration, rawResponse);

        // Check for API error responses
        const isErrorResponse = rawResponse.includes('failed to parse stringified json') ||
          rawResponse.includes('Unexpected token') ||
          rawResponse.includes('Internal Server Error');

        if (isErrorResponse) {
          fullDisplayResponse += `\n[!] API 오류 발생. 대화를 새로 시작해주세요.\n`;
          setCurrentResponse(fullDisplayResponse);
          break;
        }

        // Parse tool calls from response
        const newToolCalls = ToolParser.extractAllToolCalls(rawResponse);
        const cleanResponse = ToolParser.removeToolBlocks(rawResponse);

        // Log parsed tool calls
        logger.logToolCalls(iteration, newToolCalls);

        if (newToolCalls.length > 0) {
          // Add assistant message with tool calls
          const assistantWithTools: Message = {
            role: 'assistant',
            content: cleanResponse || `[도구 ${newToolCalls.length}개 호출]`,
          };
          conversationMessages.push(assistantWithTools);

          // Process new tool calls
          for (let toolIndex = 0; toolIndex < newToolCalls.length; toolIndex++) {
            const toolCall = newToolCalls[toolIndex];

            if (!toolExecutor.isSupported(toolCall.toolName)) {
              // Log and show unsupported tool
              logger.logError(iteration, `Unsupported tool: ${toolCall.toolName}`);
              fullDisplayResponse += `⚠️ 미지원 도구: ${toolCall.toolName}\n`;
              setCurrentResponse(fullDisplayResponse);

              const skipMessage: Message = {
                role: 'tool',
                content: `[${toolCall.toolName}] 지원하지 않는 도구입니다. 지원 도구: file.read, file.search, file.applyTextEdits, run_terminal_command, list_directory, tree, create_new_file, edit_file`,
              };
              conversationMessages.push(skipMessage);
              continue;
            }

            // Check if confirmation needed
            const needsConfirmation = ['run_terminal_command', 'create_new_file', 'edit_file', 'file.applyTextEdits'].includes(toolCall.toolName);

            if (needsConfirmation && !autoConfirm) {
              // Save loop state and wait for confirmation
              pendingLoopStateRef.current = {
                iteration,
                toolCalls: newToolCalls,
                currentToolIndex: toolIndex,
                conversationMessages: [...conversationMessages],
                fullDisplayResponse,
                credential,
                authMode: loopAuthMode,
                a2Model: loopA2Model,
                initResult,
              };
              setPendingToolCall({ name: toolCall.toolName, args: toolCall.args });
              setState('confirming');
              loopEndReason = 'confirming'; // Prevent finally from resetting state
              return;
            }

            // Execute tool
            setState('executing_tool');
            setCurrentTool(formatToolDisplay(toolCall.toolName, toolCall.args));

            const result = await toolExecutor.execute(toolCall.toolName, toolCall.args);

            // Log tool result
            logger.logToolResult(iteration, toolCall.toolName, toolCall.args, result.result);

            // Add summarized output
            const summary = summarizeToolOutput(toolCall.toolName, toolCall.args, result.result);
            fullDisplayResponse += summary + '\n';
            setCurrentResponse(fullDisplayResponse);

            // Add tool result to conversation
            const toolResultMessage: Message = {
              role: 'tool',
              content: `[${toolCall.toolName} 결과]\n${result.result}`,
            };
            conversationMessages.push(toolResultMessage);

            setCurrentTool(null);
          }

          // Continue loop for next iteration
          setState('streaming');
        } else {
          // No more tool calls - we're done
          fullDisplayResponse += filterOutput(cleanResponse);
          setCurrentResponse(fullDisplayResponse);

          // Add final assistant message
          const assistantMessage: Message = { role: 'assistant', content: fullDisplayResponse };
          setMessages((prev) => [...prev, assistantMessage]);
          sessionService.addMessage(assistantMessage);
          loopEndReason = 'completed';
          break;
        }
      }

      if (iteration >= MAX_AGENT_ITERATIONS) {
        fullDisplayResponse += '\n\n[!] 최대 반복 횟수에 도달했습니다.';
        setCurrentResponse(fullDisplayResponse);
        const assistantMessage: Message = { role: 'assistant', content: fullDisplayResponse };
        setMessages((prev) => [...prev, assistantMessage]);
        sessionService.addMessage(assistantMessage);
        loopEndReason = 'max_iterations';
      }

    } catch (err) {
      loopEndReason = 'error';
      logger.logError(0, err instanceof Error ? err : String(err));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Don't reset state if we're waiting for tool confirmation
      if (loopEndReason === 'confirming') {
        return;
      }
      setState('idle');
      setCurrentResponse('');
      setCurrentTool(null);
      pendingLoopStateRef.current = null;
    }
  }, [currentModel, autoConfirm]);

  // Handle pending resume - useEffect to resume agentic loop after tool confirmation
  useEffect(() => {
    if (pendingResume) {
      setPendingResume(false);
      // Use setTimeout to ensure state has fully updated
      setTimeout(() => {
        resumeAgenticLoop();
      }, 50);
    }
  }, [pendingResume, resumeAgenticLoop]);

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

      <Footer state={state} model={currentModel} isAuthenticated={isAuthenticated} initializingChat={initializingChat} currentTool={currentTool ?? undefined} threadId={servicesRef.current?.sessionService.getCurrentSession(currentModel).threadId} />
    </Box>
  );
}
