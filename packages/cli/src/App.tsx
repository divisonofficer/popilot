/**
 * Main App Component for Popilot CLI
 */

import * as path from 'node:path';
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
  FileUploader,
  AVAILABLE_MODELS,
  MODEL_ALIASES,
  resolveModelName,
  DEFAULT_CONFIG,
  type Message,
  type ChatRoomInfo,
  type TransformerConfig,
  type AuthMode,
  type FileAttachment,
  type UploadedFile,
  type UserApiKey,
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

// Tools that require confirmation before execution
const CONFIRMATION_REQUIRED_TOOLS = [
  'run_terminal_command',
  'create_new_file',
  'edit_file',
  'file.applyTextEdits',
] as const;

// Valid patterns for autoconfirm (tools + special patterns)
const VALID_AUTOCONFIRM_PATTERNS = [
  ...CONFIRMATION_REQUIRED_TOOLS,
  'file.*',  // Pattern for all file tools
  'all',     // Global setting
  'dryRun',  // Auto-approve dryRun operations (no actual file changes)
] as const;

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
  const shortPath = filepath.length > 30 ? '...' + filepath.slice(-27) : filepath;

  switch (toolName) {
    case 'read_file':
    case 'file.read': {
      // Extract line count from result
      const linesMatch = result.match(/Lines: (\d+)/);
      const totalLines = linesMatch ? linesMatch[1] : '?';
      const startLine = args.startLine as number | undefined;
      const endLine = args.endLine as number | undefined;

      // 범위 표시
      let rangeStr = `(${totalLines}줄)`;
      if (startLine || endLine) {
        rangeStr = `(${startLine || 1}-${endLine || '끝'}, ${totalLines}줄)`;
      }

      // 첫 줄 미리보기 (부분 읽기인 경우만)
      let preview = '';
      if (startLine || endLine) {
        const contentLines = result.split('\n');
        // 번호가 붙은 라인 찾기 (예: "  10\t" 또는 "  10|")
        const contentStart = contentLines.findIndex(l => l.match(/^\s*\d+[\t|]/));
        if (contentStart !== -1) {
          const firstContent = contentLines[contentStart].replace(/^\s*\d+[\t|]\s*/, '');
          preview = ` "${firstContent.slice(0, 30).trim()}${firstContent.length > 30 ? '...' : ''}"`;
        }
      }

      return `📄 파일 읽기: ${shortPath} ${rangeStr}${preview}`;
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
      const edits = args.edits as Array<{ startLine?: number; endLine?: number; newText?: string }> | undefined;
      const editCount = Array.isArray(edits) ? edits.length : 1;
      const isDryRun = args.dryRun === true || args.dryRun === 'true' || args.dryRun === 'True';

      // ERROR/WARNING 메시지는 그대로 표시
      if (result.startsWith('[ERROR]') || result.startsWith('[WARNING]')) {
        const firstLine = result.split('\n')[0];
        return `⚠️ ${firstLine}`;
      }

      // diff 미리보기 생성 (최대 2개 편집)
      let diffPreview = '';
      if (Array.isArray(edits) && edits.length > 0) {
        const previewLines: string[] = [];

        for (const edit of edits.slice(0, 2)) {
          const startLine = edit.startLine ?? 1;
          const endLineVal = edit.endLine;
          const newText = edit.newText ?? '';

          // 삭제 라인 (endLine이 startLine보다 크면 삭제됨)
          if (endLineVal && endLineVal >= startLine && !newText) {
            previewLines.push(`  - L${startLine}-${endLineVal} 삭제`);
          } else if (endLineVal && endLineVal >= startLine && newText) {
            previewLines.push(`  ± L${startLine}-${endLineVal} 교체`);
          }

          // 추가/교체 라인 미리보기
          if (newText) {
            const firstNewLine = newText.split('\n')[0].trim();
            const truncated = firstNewLine.slice(0, 35);
            previewLines.push(`  + "${truncated}${firstNewLine.length > 35 ? '...' : ''}"`);
          }
        }

        if (edits.length > 2) {
          previewLines.push(`  ... +${edits.length - 2}개 편집`);
        }

        if (previewLines.length > 0) {
          diffPreview = '\n' + previewLines.join('\n');
        }
      }

      // dryRun이면 Preview SHA256도 표시
      if (isDryRun) {
        const shaMatch = result.match(/Preview SHA256: ([a-f0-9]+)/);
        const previewSha = shaMatch ? ` → ${shaMatch[1].slice(0, 12)}...` : '';
        return `🔍 [DRY RUN] 미리보기: ${shortPath} (${editCount}개 편집)${previewSha}${diffPreview}`;
      }

      return `✏️ 파일 부분 수정: ${shortPath} (${editCount}개 편집)${diffPreview}`;
    }

    case 'file.search': {
      const pattern = String(args.pattern || '');
      const shortPattern = pattern.length > 15 ? pattern.slice(0, 15) + '...' : pattern;
      const matchCount = result.match(/Found (\d+) matches/);
      const matches = matchCount ? matchCount[1] : '0';

      // 첫 매칭 내용 추출 (Line N: content)
      let firstMatch = '';
      const lineMatch = result.match(/Line \d+:\s*(.+)/);
      if (lineMatch) {
        const matchText = lineMatch[1].trim();
        firstMatch = ` → "${matchText.slice(0, 30)}${matchText.length > 30 ? '...' : ''}"`;
      }

      return `🔍 파일 검색: "${shortPattern}" in ${shortPath} (${matches}개)${firstMatch}`;
    }

    case 'run_terminal_command': {
      const command = String(args.command || '');
      const shortCmd = command.length > 50 ? command.slice(0, 50) + '...' : command;
      return `💻 명령 실행: ${shortCmd}`;
    }

    case 'find_files':
    case 'file.find': {
      const pattern = String(args.pattern || args.name || args.query || '*');

      // 파일 리스트 파싱: "Found N file(s)...\n  - path1\n  - path2"
      const fileLines = result.split('\n').filter(l => l.startsWith('  - '));
      const files = fileLines.map(l => {
        const fullPath = l.replace('  - ', '').trim();
        // 파일명만 추출
        const parts = fullPath.split('/');
        return parts[parts.length - 1];
      });

      // 한 줄에 맞게 truncate (45자 제한)
      let fileList = files.join(', ');
      if (fileList.length > 45) {
        const shown: string[] = [];
        let len = 0;
        for (const f of files) {
          if (len + f.length + 2 > 40) break;
          shown.push(f);
          len += f.length + 2;
        }
        fileList = shown.join(', ') + ` +${files.length - shown.length}개`;
      }

      return `🔍 파일 검색: "${pattern}" → ${fileList || '없음'}`;
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

/**
 * Sanitize backticks in text to avoid A2 API parsing issues.
 * Replaces ` (U+0060) with ‵ (U+2035 REVERSED PRIME) - visually similar but API-safe.
 */
function sanitizeBackticks(text: string): string {
  return text.replace(/`/g, '\u2035');
}

export function App({ model, workingDir, transformerConfig }: AppProps) {
  const { exit } = useApp();
  const { setRawMode } = useStdin();

  // State
  const [state, setState] = useState<AppState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionTitle, setSessionTitle] = useState<string | undefined>(undefined);
  const [currentResponse, setCurrentResponse] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Throttled response update - 50ms 간격으로 UI 업데이트 (스크롤 부드럽게)
  const pendingResponseRef = useRef<string>('');
  const responseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttledSetCurrentResponse = useCallback((value: string) => {
    pendingResponseRef.current = value;
    if (!responseTimerRef.current) {
      responseTimerRef.current = setTimeout(() => {
        setCurrentResponse(pendingResponseRef.current);
        responseTimerRef.current = null;
      }, 50);
    }
  }, []);
  // Immediate update (for final values)
  const flushCurrentResponse = useCallback((value: string) => {
    if (responseTimerRef.current) {
      clearTimeout(responseTimerRef.current);
      responseTimerRef.current = null;
    }
    pendingResponseRef.current = value;
    setCurrentResponse(value);
  }, []);
  const [currentModel, setCurrentModel] = useState(model);
  const [pendingToolCall, setPendingToolCall] = useState<{ name: string; args: Record<string, unknown> } | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [chatRoomInfo, setChatRoomInfo] = useState<ChatRoomInfo | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [initializingChat, setInitializingChat] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  // Per-tool autoconfirm settings (supports patterns like 'file.*')
  const [autoConfirmSettings, setAutoConfirmSettings] = useState<Record<string, boolean>>({});
  const [pendingResume, setPendingResume] = useState(false);

  // Check if a tool should be auto-confirmed
  const shouldAutoConfirm = useCallback((toolName: string, args?: Record<string, unknown>): boolean => {
    // Check dryRun - if dryRun setting is on and this is a dryRun call, auto-approve
    if (args && autoConfirmSettings['dryRun']) {
      const isDryRun = args.dryRun === true || args.dryRun === 'true' || args.dryRun === 'True';
      if (isDryRun) {
        return true;
      }
    }

    // Exact match first
    if (autoConfirmSettings[toolName] !== undefined) {
      return autoConfirmSettings[toolName];
    }
    // Pattern match (e.g., 'file.*' matches 'file.read', 'file.applyTextEdits')
    for (const pattern of Object.keys(autoConfirmSettings)) {
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -1); // 'file.' from 'file.*'
        if (toolName.startsWith(prefix)) {
          return autoConfirmSettings[pattern];
        }
      }
    }
    // Global 'all' setting
    if (autoConfirmSettings['all'] !== undefined) {
      return autoConfirmSettings['all'];
    }
    return false;
  }, [autoConfirmSettings]);
  const [authMode, setAuthMode] = useState<AuthMode>('apikey');
  const [ssoToken, setSsoToken] = useState<string | null>(null);  // SSO token for file uploads
  const ssoTokenRef = useRef<string | null>(null);  // Sync ref for SSO token (React state is async)
  const [ssoStatus, setSsoStatus] = useState<'idle' | 'authenticating' | 'success' | 'failed'>('idle');
  const [isInitializing, setIsInitializing] = useState(true);  // Auto-auth on startup
  // Use ref for file attachments - useState is async and won't update in same iteration
  const pendingFileAttachmentsRef = useRef<FileAttachment[]>([]);

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
    fileUploader: FileUploader;
  } | null>(null);

  // Ref for pending loop state during tool confirmation
  const pendingLoopStateRef = useRef<PendingLoopState | null>(null);

  // Interrupt support - allows user to send new message while AI is responding
  const abortControllerRef = useRef<AbortController | null>(null);
  const [interruptInput, setInterruptInput] = useState<string | null>(null);
  const currentResponseRef = useRef<string>('');  // Track current response for interrupt

  // Keep currentResponseRef in sync with currentResponse for interrupt handling
  useEffect(() => {
    currentResponseRef.current = currentResponse;
  }, [currentResponse]);

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
      onAuthStart: () => {
        setSsoStatus('authenticating');
      },
      onAuthComplete: (success: boolean, _error?: string) => {
        setSsoStatus(success ? 'success' : 'failed');
        // Reset to idle after 3 seconds
        setTimeout(() => setSsoStatus('idle'), 3000);
      },
    });

    // API Key authentication
    const apiKeyStorage = new ApiKeyStorage();
    const apiKeyAuthenticator = new ApiKeyAuthenticator({
      storage: apiKeyStorage,
    });

    const client = new PostechClient({
      apiUrl: DEFAULT_CONFIG.apiUrl,
    });

    // Use project-local .popilot directory for sessions and logs
    const sessionService = new SessionService({
      sessionsDir: path.join(workingDir, '.popilot', 'sessions'),
    });
    const toolExecutor = new ToolExecutor({ workspaceDir: workingDir });

    // Initialize transformer with model-specific settings
    const initialModelConfig = AVAILABLE_MODELS[model];
    const transformer = new RequestTransformer({
      ...transformerConfig,
      modelProvider: initialModelConfig?.provider ?? 'anthropic',
    });
    const logger = new DebugLogger(workingDir, true);
    const fileUploader = new FileUploader();

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
      fileUploader,
    };

    // Check authentication status on startup
    setIsAuthenticated(tokenManager.hasValidToken());

    // Restore last session if available
    const lastSession = sessionService.loadLastSession();
    if (lastSession && lastSession.messages.length > 0) {
      setMessages(lastSession.messages);
      setCurrentModel(lastSession.model);
      setSessionTitle(lastSession.title);
      console.log(`📂 이전 세션 복원됨: ${lastSession.title ?? '(무제)'} (${lastSession.messages.length}개 메시지)`);
    }

    // Set raw mode for input handling
    setRawMode(true);

    return () => {
      // Flush any pending saves before shutdown
      sessionService.flushSave();
      setRawMode(false);
    };
  }, [workingDir, setRawMode]);

  /**
   * Fetch API key from server using SSO token and save it.
   */
  const fetchAndSaveApiKey = useCallback(async (ssoToken: string): Promise<string | null> => {
    if (!servicesRef.current) return null;
    const { client, apiKeyStorage } = servicesRef.current;

    try {
      console.log('Fetching API keys from server...');
      const apiKeys = await client.getUserApiKeys(ssoToken);

      if (apiKeys.length > 0) {
        // Use the first (most recent) API key
        const apiKey = apiKeys[0].rawApiKey;
        apiKeyStorage.saveApiKey(apiKey);
        console.log(`API key saved: ${apiKeys[0].apiKeyPreview}`);
        return apiKey;
      } else {
        console.log('No API keys found on server. Please create one at https://genai.postech.ac.kr');
        return null;
      }
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
      return null;
    }
  }, []);

  /**
   * Auto-authenticate on startup.
   * Always attempt SSO to get token (needed for thread ID and file uploads).
   */
  useEffect(() => {
    if (!servicesRef.current) return;

    const autoAuthenticate = async () => {
      const { apiKeyAuthenticator, tokenManager } = servicesRef.current!;

      const hasApiKey = apiKeyAuthenticator.hasApiKey();

      if (hasApiKey) {
        console.log('Using stored API key');
      } else {
        console.log('No API key found. Starting SSO authentication...');
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: '[SYSTEM] API 키가 없습니다. SSO 로그인을 시작합니다...',
        }]);
      }

      // Always try SSO to get token (needed for thread ID and file uploads)
      try {
        const token = await tokenManager.getValidToken();
        setSsoToken(token);
        ssoTokenRef.current = token;  // Sync update for immediate use
        setIsAuthenticated(true);
        console.log('SSO token acquired');

        // If no API key, fetch from server
        if (!hasApiKey) {
          const apiKey = await fetchAndSaveApiKey(token);
          if (apiKey) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: '[SYSTEM] API 키를 서버에서 가져와 저장했습니다.',
            }]);
          } else {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: '[SYSTEM] 서버에 API 키가 없습니다. https://genai.postech.ac.kr 에서 API 키를 발급받으세요.',
            }]);
          }
        }
      } catch (error) {
        console.error('SSO authentication failed:', error);
        if (!hasApiKey) {
          // Only show error if we needed SSO for API key
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] 자동 인증 실패: ${error instanceof Error ? error.message : String(error)}`,
          }]);
        } else {
          // API key exists but SSO failed - just log, don't block
          console.log('SSO failed but API key available - continuing without SSO token');
        }
      } finally {
        setIsInitializing(false);
      }
    };

    // Delay to ensure services are fully initialized
    const timer = setTimeout(autoAuthenticate, 100);
    return () => clearTimeout(timer);
  }, [fetchAndSaveApiKey]);

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

    const { client, tokenManager, apiKeyAuthenticator, sessionService, transformer, toolExecutor, logger, fileUploader } = servicesRef.current;

    // Ensure session exists
    sessionService.getCurrentSession(currentModel);

    // Add user message
    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    sessionService.addMessage(userMessage);

    // Generate session title from first user message
    const generatedTitle = sessionService.generateTitleFromFirstMessage();
    if (generatedTitle) {
      setSessionTitle(generatedTitle);
    }

    setState('streaming');
    flushCurrentResponse('');
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
        const transformResult = transformer.transform(conversationMessages);
        const { message: text, files: transformerFiles } = transformResult;

        // Combine transformer files with pending file attachments from tool results
        const pendingAttachments = [...transformerFiles, ...pendingFileAttachmentsRef.current];
        // Clear pending attachments after combining (they'll be sent with this request)
        if (pendingFileAttachmentsRef.current.length > 0) {
          pendingFileAttachmentsRef.current = [];
        }

        // Upload pending files if we have SSO token
        let uploadedFiles: Array<{ id: string; name: string; url: string }> = [];
        const pendingUploads = pendingAttachments.filter(f => f._pendingContent);

        if (pendingUploads.length > 0) {
          // Try to get SSO token for file uploads
          let uploadToken = ssoToken;
          if (!uploadToken) {
            try {
              uploadToken = await tokenManager.getValidToken();
              setSsoToken(uploadToken);
              ssoTokenRef.current = uploadToken;  // Sync update
            } catch {
              // No SSO token available - warn and skip file uploads
              console.log('⚠️ SSO 토큰 없음 - 파일 첨부 건너뜀');
              fullDisplayResponse += '[!] 파일 첨부를 위해 SSO 인증이 필요합니다. /sso로 로그인해주세요.\n';
              flushCurrentResponse(fullDisplayResponse);
            }
          }

          if (uploadToken) {
            try {
              console.log(`📤 파일 업로드 중... (${pendingUploads.length}개)`);
              for (const attachment of pendingUploads) {
                const uploaded = await fileUploader.upload(uploadToken, {
                  filename: attachment.name,
                  content: attachment._pendingContent!,
                  mimeType: attachment._pendingMimeType,
                });
                uploadedFiles.push({ id: uploaded.id, name: uploaded.name, url: uploaded.url });
                console.log(`✅ 업로드 완료: ${uploaded.name} (${uploaded.id}) → ${uploaded.url}`);
              }
            } catch (uploadError) {
              console.error('파일 업로드 실패:', uploadError);
              fullDisplayResponse += `[!] 파일 업로드 실패: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}\n`;
              flushCurrentResponse(fullDisplayResponse);
            }
          }
        }

        // Stream response - just accumulate, don't parse during streaming
        setState('streaming');
        let rawResponse = '';

        if (authMode === 'apikey') {
          // Get thread ID from session for conversation continuity (if available)
          const currentThreadId = sessionService.getCurrentSession(currentModel).threadId;
          const a2Options = currentThreadId ? { chatThreadsId: currentThreadId } : undefined;

          // Log A2 API request with thread ID
          logger.logA2Request(iteration, text, a2Model, uploadedFiles, currentThreadId);

          // Log thread ID usage
          if (currentThreadId) {
            logger.logThreadId(iteration, 'use', currentThreadId, 'Sending with A2 request');
          } else {
            logger.logThreadId(iteration, 'use', null, 'No thread ID - first request');
          }

          // A2 API - simpler payload with uploaded file IDs
          for await (const chunk of client.streamQueryA2(credential, text, a2Model, false, uploadedFiles, a2Options)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse = chunk.content; // A2 returns full response, not incremental
              const displayText = filterOutput(rawResponse);
              throttledSetCurrentResponse(fullDisplayResponse + displayText);
            }
          }

          // After first A2 response, fetch thread ID for conversation continuity
          if (!currentThreadId) {
            if (!ssoTokenRef.current) {
              logger.logThreadId(iteration, 'fetch', null, 'Skipped - no SSO token available (API key only mode)');
            } else {
              logger.logThreadId(iteration, 'fetch', null, 'Attempting to fetch latest thread ID');
              try {
                const latestThreadId = await client.getLatestThreadId(ssoTokenRef.current!);
                if (latestThreadId) {
                  sessionService.setThreadId(latestThreadId);
                  logger.logThreadId(iteration, 'save', latestThreadId, 'Saved to session');
                } else {
                  logger.logThreadId(iteration, 'fetch', null, 'No thread ID returned from server');
                }
              } catch (threadError) {
                logger.logThreadId(iteration, 'fetch', null, `Error: ${threadError instanceof Error ? threadError.message : String(threadError)}`);
                // Non-critical error - continue without thread ID
              }
            }
          }
        } else {
          // SSO API - full payload with chat room (file attachments not supported in SSO mode)
          const payload = PostechClient.buildPayload(
            text,  // transformResult.message
            initResult!.userInfo,
            modelConfig,
            sessionService.getCurrentSession(currentModel).threadId
          );
          logger.logRequest(iteration, payload);

          for await (const chunk of client.streamQuery(credential, payload)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse += chunk.content;
              const displayText = filterOutput(rawResponse);
              throttledSetCurrentResponse(fullDisplayResponse + displayText);
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
            flushCurrentResponse(fullDisplayResponse);
            const errorMessage: Message = {
              role: 'assistant',
              content: '[API 오류로 인해 요청을 처리할 수 없습니다. /clear로 대화를 초기화해주세요.]',
            };
            setMessages((prev) => [...prev, errorMessage]);
            break;
          }

          fullDisplayResponse += `\n[!] API 오류 발생, 재시도 중... (${errorRetryCount}/${MAX_ERROR_RETRIES})\n`;
          flushCurrentResponse(fullDisplayResponse);
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
          flushCurrentResponse(fullDisplayResponse);
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
          flushCurrentResponse(fullDisplayResponse);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        // Log parsed tool calls
        logger.logToolCalls(iteration, toolCalls);

        if (toolCalls.length > 0) {
          // Add assistant message with tool calls to conversation history FIRST
          // Sanitize backticks for API compatibility
          const assistantWithTools: Message = {
            role: 'assistant',
            content: sanitizeBackticks(cleanResponse || `[도구 ${toolCalls.length}개 호출]`),
          };
          conversationMessages.push(assistantWithTools);

          // Execute all tool calls (using index to track position for resumption)
          for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
            const toolCall = toolCalls[toolIndex];

            if (!toolExecutor.isSupported(toolCall.toolName)) {
              // Log and show unsupported tool
              logger.logError(iteration, `Unsupported tool: ${toolCall.toolName}`);
              fullDisplayResponse += `⚠️ 미지원 도구: ${toolCall.toolName}\n`;
              flushCurrentResponse(fullDisplayResponse);

              // Add skip message for unsupported tools
              const skipMessage: Message = {
                role: 'tool',
                content: `[${toolCall.toolName}] 지원하지 않는 도구입니다. 지원 도구: file.read, file.search, file.applyTextEdits, run_terminal_command, list_directory, tree, create_new_file, edit_file`,
              };
              conversationMessages.push(skipMessage);
              continue;
            }

            // Check if confirmation needed
            const needsConfirmation = CONFIRMATION_REQUIRED_TOOLS.includes(toolCall.toolName as typeof CONFIRMATION_REQUIRED_TOOLS[number]);

            if (needsConfirmation && !shouldAutoConfirm(toolCall.toolName, toolCall.args)) {
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

            // Collect file attachment if present (for large file.read results)
            if (result.fileAttachment) {
              pendingFileAttachmentsRef.current.push(result.fileAttachment);
            }

            // Add summarized output to display response
            const summary = summarizeToolOutput(toolCall.toolName, toolCall.args, result.result);
            fullDisplayResponse += summary + '\n';
            flushCurrentResponse(fullDisplayResponse);

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
          flushCurrentResponse(fullDisplayResponse);

          // Add final assistant message (sanitize backticks for API compatibility)
          const assistantMessage: Message = { role: 'assistant', content: sanitizeBackticks(fullDisplayResponse) };
          setMessages((prev) => [...prev, assistantMessage]);
          sessionService.addMessage(assistantMessage);
          logger.logLoopEnd(loopEndReason, iteration, `response_length=${fullDisplayResponse.length}`);
          break;
        }
      }

      if (iteration >= MAX_AGENT_ITERATIONS) {
        loopEndReason = 'max_iterations';
        fullDisplayResponse += '\n\n[!] 최대 반복 횟수에 도달했습니다.';
        flushCurrentResponse(fullDisplayResponse);
        const assistantMessage: Message = { role: 'assistant', content: sanitizeBackticks(fullDisplayResponse) };
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
      flushCurrentResponse('');
      setCurrentTool(null);
    }
  }, [state, messages, currentModel, initializeChatRoom, shouldAutoConfirm]);

  // Handle interrupt - user sends new message while AI is responding
  const handleInterrupt = useCallback((input: string) => {
    if (state !== 'streaming') return;
    if (!input.trim()) return;

    // Abort current request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Save the interrupt input to be processed after current response stops
    setInterruptInput(input);

    // Add partial response to history if any
    const partialResponse = currentResponseRef.current;
    if (partialResponse && partialResponse.trim()) {
      const partialMessage: Message = {
        role: 'assistant',
        content: sanitizeBackticks(partialResponse + '\n\n[응답 중단됨]'),
      };
      setMessages((prev) => [...prev, partialMessage]);
      servicesRef.current?.sessionService.addMessage(partialMessage);
    }

    // Reset state
    setState('idle');
    flushCurrentResponse('');
    setCurrentTool(null);
    pendingLoopStateRef.current = null;
    currentResponseRef.current = '';
  }, [state]);

  // Process interrupt input when state becomes idle
  useEffect(() => {
    if (state === 'idle' && interruptInput) {
      const input = interruptInput;
      setInterruptInput(null);
      // Use setTimeout to ensure state update is complete
      setTimeout(() => {
        handleSubmit(input);
      }, 50);
    }
  }, [state, interruptInput, handleSubmit]);

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
        setSessionTitle(undefined);
        // Clear current session and create a new one
        servicesRef.current?.sessionService.clearCurrentSession();
        // Force create a new session with new ID
        servicesRef.current?.sessionService.createSession(currentModel);
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: '[SYSTEM] 새 세션이 시작되었습니다.',
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
          content: `[SYSTEM] 명령어: /model, /clear, /thread, /retry, /config, /autoconfirm, /session, /api, /api-refresh, /sso, /auth, /log, /logout, /quit`,
        }]);
        break;

      case 'log': {
        // /log - show log stats
        // /log archive - archive logs to subfolder
        // /log delete - delete all logs
        // /log archives - list archived folders
        const { logger } = servicesRef.current!;
        const subCmd = args[0]?.toLowerCase();

        if (!subCmd) {
          // Show log stats
          const stats = logger.getLogStats();
          const sizeKB = (stats.totalSize / 1024).toFixed(1);
          const archives = logger.listArchives();
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] 로그 현황:
- 파일 수: ${stats.fileCount}개
- 총 크기: ${sizeKB} KB
- 경로: ${logger.getLogDir()}
- 아카이브: ${archives.length}개

명령어:
- /log archive - 현재 로그를 아카이브 폴더로 이동
- /log delete - 현재 로그 삭제
- /log archives - 아카이브 목록 보기`,
          }]);
        } else if (subCmd === 'archive') {
          const result = logger.archiveLogs();
          if (result.success) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] ${result.fileCount}개 로그 파일을 아카이브했습니다.
→ ${result.archiveDir}`,
            }]);
          } else {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 아카이브 실패: ${result.error}`,
            }]);
          }
        } else if (subCmd === 'delete' || subCmd === 'clear') {
          const result = logger.deleteLogs();
          if (result.success) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] ${result.fileCount}개 로그 파일을 삭제했습니다.`,
            }]);
          } else {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 삭제 실패: ${result.error}`,
            }]);
          }
        } else if (subCmd === 'archives' || subCmd === 'list') {
          const archives = logger.listArchives();
          if (archives.length === 0) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 아카이브 없음`,
            }]);
          } else {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 아카이브 목록 (${archives.length}개):
${archives.map(a => `- ${a}`).join('\n')}`,
            }]);
          }
        } else {
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] 사용법: /log, /log archive, /log delete, /log archives`,
          }]);
        }
        break;
      }

      case 'autoconfirm':
      case 'auto': {
        // /autoconfirm - show current settings
        // /autoconfirm <tool> on|off - set per-tool (e.g., /autoconfirm file.applyTextEdits on)
        // /autoconfirm all on|off - set global default
        // /autoconfirm reset - clear all settings
        if (!args[0]) {
          // Show current settings and available tools
          const settings = Object.entries(autoConfirmSettings);
          const toolList = VALID_AUTOCONFIRM_PATTERNS.join(', ');
          const msg = settings.length === 0
            ? `자동승인 설정 없음 (모든 도구 수동 확인)\n\n사용 가능한 도구: ${toolList}\n\n사용법:\n  /autoconfirm <tool> on|off\n  /autoconfirm file.* on\n  /autoconfirm all on\n  /autoconfirm reset`
            : `자동승인 설정:\n${settings.map(([k, v]) => `  ${k}: ${v ? 'ON' : 'OFF'}`).join('\n')}\n\n사용 가능한 도구: ${toolList}`;
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: `[SYSTEM] ${msg}`,
          }]);
        } else if (args[0] === 'reset') {
          setAutoConfirmSettings({});
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: '[SYSTEM] 자동승인 설정 초기화됨',
          }]);
        } else {
          const toolName = args[0];

          // Validate tool name
          const isValidTool = VALID_AUTOCONFIRM_PATTERNS.includes(toolName as typeof VALID_AUTOCONFIRM_PATTERNS[number]);
          if (!isValidTool) {
            const toolList = VALID_AUTOCONFIRM_PATTERNS.join(', ');
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 잘못된 도구: "${toolName}"\n\n사용 가능한 도구: ${toolList}`,
            }]);
            break;
          }

          const value = args[1]?.toLowerCase();
          if (value === 'on' || value === 'off' || value === 'true' || value === 'false') {
            const enabled = value === 'on' || value === 'true';
            setAutoConfirmSettings((prev) => ({ ...prev, [toolName]: enabled }));
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 자동승인: ${toolName} = ${enabled ? 'ON' : 'OFF'}`,
            }]);
          } else {
            // Toggle if no value specified
            const currentValue = autoConfirmSettings[toolName] ?? false;
            setAutoConfirmSettings((prev) => ({ ...prev, [toolName]: !currentValue }));
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] 자동승인: ${toolName} = ${!currentValue ? 'ON' : 'OFF'}`,
            }]);
          }
        }
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

      case 'api-refresh':
      case 'refresh-api': {
        // Refresh API key from server via SSO
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: '[SYSTEM] SSO 로그인 후 API 키를 서버에서 다시 가져옵니다...',
        }]);

        (async () => {
          try {
            const token = await servicesRef.current?.tokenManager.getValidToken();
            if (!token) {
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: '[SYSTEM] SSO 인증 실패',
              }]);
              return;
            }

            setSsoToken(token);
            ssoTokenRef.current = token;  // Sync update
            const apiKey = await fetchAndSaveApiKey(token);
            if (apiKey) {
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: '[SYSTEM] API 키가 새로고침되었습니다.',
              }]);
            } else {
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: '[SYSTEM] 서버에 API 키가 없습니다. https://genai.postech.ac.kr 에서 API 키를 발급받으세요.',
              }]);
            }
          } catch (error) {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `[SYSTEM] API 키 새로고침 실패: ${error instanceof Error ? error.message : String(error)}`,
            }]);
          }
        })();
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
setError(`\n[Popilot CLI 도움말]\n\nPopilot CLI에서는 다양한 슬래시(/) 커맨드를 사용할 수 있습니다.\n\n| 커맨드         | 설명 |\n| -------------- | ------------------------------------------------------------ |\n| /run <명령>    | 명령을 실행합니다. 예: /run ls -al |\n| /help          | 사용 가능한 커맨드와 도움말을 표시합니다. |\n| /clear         | 입력 프롬프트를 초기화합니다. |\n| /history       | 최근 실행한 명령어 목록을 보여줍니다. |\n| /exit          | CLI를 종료합니다. |\n| /model <모델명>| 사용할 AI 모델을 변경합니다. 예: /model gpt-4o |\n| /config        | 현재 설정을 확인합니다. |\n| /upload <파일> | 파일을 업로드합니다. 예: /upload report.pdf |\n| /download <파일>| 파일을 다운로드합니다. 예: /download result.txt |\n| /auth <방식>   | 인증 방식을 변경합니다. 예: /auth sso |\n| /token <토큰>  | API 토큰을 설정합니다. |\n\n> **TIP:** 입력창에 '/'를 입력하면 자동완성 기능이 활성화되어 사용 가능한 커맨드를 쉽게 확인할 수 있습니다.\n\n자세한 설명은 공식 문서를 참고하세요. 궁금한 점이 있으면 언제든 /help를 입력하세요. 😊`);
    }
  }, [exit, messages, autoConfirmSettings, authMode]);

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

      // Collect file attachment if present (for large file.read results)
      if (result.fileAttachment) {
        pendingFileAttachmentsRef.current.push(result.fileAttachment);
      }

      // Add summarized output to display response
      const summary = summarizeToolOutput(pendingToolCall.name, pendingToolCall.args, result.result);
      loopState.fullDisplayResponse += summary + '\n';
      flushCurrentResponse(loopState.fullDisplayResponse);

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
      flushCurrentResponse(loopState.fullDisplayResponse);
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
        flushCurrentResponse('');
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
    const { client, sessionService, transformer, toolExecutor, logger, fileUploader, tokenManager } = servicesRef.current;
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
          flushCurrentResponse(fullDisplayResponse);

          const skipMessage: Message = {
            role: 'tool',
            content: `[${toolCall.toolName}] 지원하지 않는 도구입니다. 지원 도구: file.read, file.search, file.applyTextEdits, run_terminal_command, list_directory, tree, create_new_file, edit_file`,
          };
          conversationMessages.push(skipMessage);
          continue;
        }

        // Check if confirmation needed
        const needsConfirmation = CONFIRMATION_REQUIRED_TOOLS.includes(toolCall.toolName as typeof CONFIRMATION_REQUIRED_TOOLS[number]);

        if (needsConfirmation && !shouldAutoConfirm(toolCall.toolName, toolCall.args)) {
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

        // Collect file attachment if present (for large file.read results)
        if (result.fileAttachment) {
          pendingFileAttachmentsRef.current.push(result.fileAttachment);
        }

        // Add summarized output to display response
        const summary = summarizeToolOutput(toolCall.toolName, toolCall.args, result.result);
        fullDisplayResponse += summary + '\n';
        flushCurrentResponse(fullDisplayResponse);

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
        const transformResult = transformer.transform(conversationMessages);
        const { message: text, files: transformerFiles } = transformResult;

        // Combine transformer files with pending file attachments from tool results
        const pendingAttachments = [...transformerFiles, ...pendingFileAttachmentsRef.current];
        // Clear pending attachments after combining
        if (pendingFileAttachmentsRef.current.length > 0) {
          pendingFileAttachmentsRef.current = [];
        }

        // Upload pending files if we have SSO token
        let uploadedFiles: Array<{ id: string; name: string; url: string }> = [];
        const pendingUploads = pendingAttachments.filter(f => f._pendingContent);

        if (pendingUploads.length > 0) {
          // Try to get SSO token for file uploads
          let uploadToken = ssoToken;
          if (!uploadToken) {
            try {
              uploadToken = await tokenManager.getValidToken();
              setSsoToken(uploadToken);
              ssoTokenRef.current = uploadToken;  // Sync update
            } catch {
              // No SSO token available - skip file uploads
              console.log('⚠️ SSO 토큰 없음 - 파일 첨부 건너뜀');
            }
          }

          if (uploadToken) {
            try {
              console.log(`📤 파일 업로드 중... (${pendingUploads.length}개)`);
              for (const attachment of pendingUploads) {
                const uploaded = await fileUploader.upload(uploadToken, {
                  filename: attachment.name,
                  content: attachment._pendingContent!,
                  mimeType: attachment._pendingMimeType,
                });
                uploadedFiles.push({ id: uploaded.id, name: uploaded.name, url: uploaded.url });
                console.log(`✅ 업로드 완료: ${uploaded.name} (${uploaded.id}) → ${uploaded.url}`);
              }
            } catch (uploadError) {
              console.error('파일 업로드 실패:', uploadError);
            }
          }
        }

        // Stream response
        setState('streaming');
        let rawResponse = '';

        if (loopAuthMode === 'apikey') {
          // Get thread ID from session for conversation continuity
          const currentThreadId = sessionService.getCurrentSession(currentModel).threadId;
          const a2Options = currentThreadId ? { chatThreadsId: currentThreadId } : undefined;

          // Log A2 API request with thread ID
          logger.logA2Request(iteration, text, loopA2Model, uploadedFiles, currentThreadId);

          // Log thread ID usage
          if (currentThreadId) {
            logger.logThreadId(iteration, 'use', currentThreadId, 'Sending with A2 request (resumed loop)');
          } else {
            logger.logThreadId(iteration, 'use', null, 'No thread ID - resumed loop');
          }

          // A2 API with uploaded file IDs
          for await (const chunk of client.streamQueryA2(credential, text, loopA2Model, false, uploadedFiles, a2Options)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse = chunk.content;
              const displayText = filterOutput(rawResponse);
              throttledSetCurrentResponse(fullDisplayResponse + displayText);
            }
          }

          // After first A2 response, fetch thread ID for conversation continuity
          if (!currentThreadId) {
            if (!ssoTokenRef.current) {
              logger.logThreadId(iteration, 'fetch', null, 'Skipped - no SSO token (resumed loop)');
            } else {
              logger.logThreadId(iteration, 'fetch', null, 'Attempting to fetch (resumed loop)');
              try {
                const latestThreadId = await client.getLatestThreadId(ssoTokenRef.current!);
                if (latestThreadId) {
                  sessionService.setThreadId(latestThreadId);
                  logger.logThreadId(iteration, 'save', latestThreadId, 'Saved (resumed loop)');
                }
              } catch {
                // Non-critical error - continue without thread ID
              }
            }
          }
        } else {
          // SSO API (file attachments not supported)
          const payload = PostechClient.buildPayload(
            text,  // transformResult.message
            initResult!.userInfo,
            modelConfig,
            sessionService.getCurrentSession(currentModel).threadId
          );
          logger.logRequest(iteration, payload);

          for await (const chunk of client.streamQuery(credential, payload)) {
            if (chunk.type === 'text' && chunk.content) {
              rawResponse += chunk.content;
              const displayText = filterOutput(rawResponse);
              throttledSetCurrentResponse(fullDisplayResponse + displayText);
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
          flushCurrentResponse(fullDisplayResponse);
          break;
        }

        // Parse tool calls from response
        const newToolCalls = ToolParser.extractAllToolCalls(rawResponse);
        const cleanResponse = ToolParser.removeToolBlocks(rawResponse);

        // Log parsed tool calls
        logger.logToolCalls(iteration, newToolCalls);

        if (newToolCalls.length > 0) {
          // Add assistant message with tool calls (sanitize backticks for API compatibility)
          const assistantWithTools: Message = {
            role: 'assistant',
            content: sanitizeBackticks(cleanResponse || `[도구 ${newToolCalls.length}개 호출]`),
          };
          conversationMessages.push(assistantWithTools);

          // Process new tool calls
          for (let toolIndex = 0; toolIndex < newToolCalls.length; toolIndex++) {
            const toolCall = newToolCalls[toolIndex];

            if (!toolExecutor.isSupported(toolCall.toolName)) {
              // Log and show unsupported tool
              logger.logError(iteration, `Unsupported tool: ${toolCall.toolName}`);
              fullDisplayResponse += `⚠️ 미지원 도구: ${toolCall.toolName}\n`;
              flushCurrentResponse(fullDisplayResponse);

              const skipMessage: Message = {
                role: 'tool',
                content: `[${toolCall.toolName}] 지원하지 않는 도구입니다. 지원 도구: file.read, file.search, file.applyTextEdits, run_terminal_command, list_directory, tree, create_new_file, edit_file`,
              };
              conversationMessages.push(skipMessage);
              continue;
            }

            // Check if confirmation needed
            const needsConfirmation = CONFIRMATION_REQUIRED_TOOLS.includes(toolCall.toolName as typeof CONFIRMATION_REQUIRED_TOOLS[number]);

            if (needsConfirmation && !shouldAutoConfirm(toolCall.toolName, toolCall.args)) {
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

            // Collect file attachment if present (for large file.read results)
            if (result.fileAttachment) {
              pendingFileAttachmentsRef.current.push(result.fileAttachment);
            }

            // Add summarized output
            const summary = summarizeToolOutput(toolCall.toolName, toolCall.args, result.result);
            fullDisplayResponse += summary + '\n';
            flushCurrentResponse(fullDisplayResponse);

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
          flushCurrentResponse(fullDisplayResponse);

          // Add final assistant message (sanitize backticks for API compatibility)
          const assistantMessage: Message = { role: 'assistant', content: sanitizeBackticks(fullDisplayResponse) };
          setMessages((prev) => [...prev, assistantMessage]);
          sessionService.addMessage(assistantMessage);
          loopEndReason = 'completed';
          break;
        }
      }

      if (iteration >= MAX_AGENT_ITERATIONS) {
        fullDisplayResponse += '\n\n[!] 최대 반복 횟수에 도달했습니다.';
        flushCurrentResponse(fullDisplayResponse);
        const assistantMessage: Message = { role: 'assistant', content: sanitizeBackticks(fullDisplayResponse) };
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
      flushCurrentResponse('');
      setCurrentTool(null);
      pendingLoopStateRef.current = null;
    }
  }, [currentModel, shouldAutoConfirm]);

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

      {/* SSO 인증 상태 표시 */}
      {ssoStatus === 'authenticating' && (
        <Box marginY={1} paddingX={1}>
          <Text color="yellow">🔐 SSO 인증 요청 중... 브라우저에서 로그인해주세요</Text>
        </Box>
      )}
      {ssoStatus === 'success' && (
        <Box marginY={1} paddingX={1}>
          <Text color="green">✅ SSO 인증 완료</Text>
        </Box>
      )}
      {ssoStatus === 'failed' && (
        <Box marginY={1} paddingX={1}>
          <Text color="red">❌ SSO 인증 실패</Text>
        </Box>
      )}

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
          onSubmit={state === 'streaming' ? handleInterrupt : handleSubmit}
          disabled={state === 'executing_tool'}
          placeholder={state === 'streaming' ? '메시지 입력으로 중단 (Esc도 가능)' : '메시지를 입력하세요 (/help)'}
        />
      )}

      <Footer state={state} model={currentModel} isAuthenticated={isAuthenticated} initializingChat={initializingChat} currentTool={currentTool ?? undefined} threadId={servicesRef.current?.sessionService.getCurrentSession(currentModel).threadId} sessionTitle={sessionTitle} messageCount={messages.length} />
    </Box>
  );
}
