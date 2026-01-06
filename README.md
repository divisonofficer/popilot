# Popilot

**POSTECH GenAI CLI Agent** - Claude, GPT, Gemini와 함께하는 터미널 기반 AI 코딩 어시스턴트

## 소개

Popilot은 POSTECH GenAI API를 활용한 터미널 기반 AI 코딩 어시스턴트입니다. Claude, GPT, Gemini 등 다양한 LLM 모델을 지원하며, 인터랙티브한 CLI 환경에서 코딩 작업을 도와줍니다.

## 주요 기능

- **다중 모델 지원**: Claude Sonnet 4.5, GPT 5.1, Gemini 3.0 Pro
- **SSE 스트리밍**: 실시간 응답 스트리밍
- **POSTECH SSO 인증**: JWT 토큰 기반 인증
- **세션 관리**: 대화 히스토리 저장 및 불러오기
- **도구 실행**: 터미널 명령어, 파일 읽기/쓰기 등

## 요구 사항

- **Node.js**: 20.0.0 이상
- **npm**: 10.2.0 이상
- **POSTECH 계정**: GenAI 서비스 접근 권한 필요

## 설치 방법

### 1. 저장소 클론

```bash
git clone https://github.com/your-username/popilot.git
cd popilot
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 프로젝트 빌드

```bash
npm run build
```

### 4. 실행

```bash
# CLI 실행
npm run start --workspace=@popilot/cli

# 또는 직접 실행
node packages/cli/dist/cli.js
```

## 사용법

### 기본 실행

```bash
node packages/cli/dist/cli.js
```

### 옵션

```bash
node packages/cli/dist/cli.js --model claude  # Claude 모델 사용
node packages/cli/dist/cli.js --model gpt     # GPT 모델 사용
node packages/cli/dist/cli.js --model gemini  # Gemini 모델 사용
```

### JWT 토큰 인증

처음 실행 시 JWT 토큰을 입력해야 합니다:

1. [POSTECH GenAI](https://genai.postech.ac.kr) 접속
2. 로그인 후 브라우저 개발자 도구(F12) 열기
3. Network 탭에서 아무 API 요청의 `Authorization` 헤더에서 Bearer 토큰 복사
4. CLI에 토큰 입력

## 슬래시 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/model <name>` | 모델 변경 (claude, gpt, gemini) |
| `/clear` | 대화 초기화 |
| `/session save` | 세션 저장 |
| `/session list` | 저장된 세션 목록 |
| `/session load <id>` | 세션 불러오기 |
| `/help` | 도움말 |
| `/quit` 또는 `/exit` | 종료 |

## 프로젝트 구조

```
popilot/
├── packages/
│   ├── core/                    # 핵심 라이브러리
│   │   ├── src/
│   │   │   ├── auth/           # 인증 (SSO, 토큰 관리)
│   │   │   ├── client/         # POSTECH API 클라이언트
│   │   │   ├── tools/          # 도구 실행기 (shell, file)
│   │   │   ├── services/       # 세션 관리
│   │   │   └── types.ts        # 타입 정의
│   │   └── package.json
│   └── cli/                     # CLI 애플리케이션
│       ├── src/
│       │   ├── ui/             # UI 컴포넌트 (Ink)
│       │   ├── App.tsx         # 메인 앱
│       │   └── cli.ts          # CLI 엔트리포인트
│       └── package.json
├── package.json                 # 워크스페이스 루트
├── tsconfig.base.json          # TypeScript 설정
└── turbo.json                  # Turborepo 설정
```

## 개발

### 개발 모드 실행

```bash
# 파일 변경 감지 및 자동 재빌드
npm run dev
```

### 타입 체크

```bash
npm run typecheck
```

### 린트

```bash
npm run lint
```

### 클린 빌드

```bash
npm run clean
npm install
npm run build
```

## 지원 모델

| 모델 | 별칭 | Provider |
|------|------|----------|
| Claude Sonnet 4.5 | `claude` | Anthropic |
| GPT 5.1 | `gpt` | Azure OpenAI |
| Gemini 3.0 Pro | `gemini` | Google |

## 문제 해결

### 토큰 만료 오류

```
Error: Authentication failed. Please re-login.
```

JWT 토큰이 만료되었습니다. 브라우저에서 새 토큰을 복사하여 다시 입력하세요.

### 네트워크 오류

```
Error: Network error: fetch failed
```

POSTECH 네트워크에 연결되어 있는지 확인하세요. VPN이 필요할 수 있습니다.

### 빌드 오류

```bash
# node_modules 삭제 후 재설치
npm run clean
npm install
npm run build
```

## 라이선스

MIT License

## 기여

버그 리포트, 기능 제안, PR 모두 환영합니다!
