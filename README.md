# Popilot

AI 기반 코드 자동화 및 CLI 도구

---

## 📁 프로젝트 구조

popilot/
├─ packages/
│  ├─ cli/           # CLI 실행 및 UI 관련 소스
│  │  ├─ src/
│  │  │  ├─ App.tsx  # 메인 앱 컴포넌트 (주요 수정 반영)
│  │  │  └─ ui/
│  │  │     └─ InputPrompt.tsx
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ core/          # 핵심 로직 및 클라이언트 코드
│  │  ├─ src/
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  └─ mcp-server/    # 서버 관련 코드
│     ├─ src/
│     ├─ package.json
│     └─ tsconfig.json
├─ package.json
├─ tsconfig.base.json
└─ turbo.json
---

## ⚡ 설치 및 실행

### 1. 의존성 설치

```bash
npm install
```

### 2. 빌드

```bash
npm run build
```

### 3. 실행

```bash
# CLI 실행 (예시)
npm run cli
```
---

## 🚀 popilot 명령어 alias 등록

`popilot` 명령어로 CLI를 간편하게 실행하려면 아래와 같이 alias를 등록하세요.

### Bash/Zsh

```bash
echo "alias popilot='node $(pwd)/packages/cli/dist/index.js'" >> ~/.bashrc
source ~/.bashrc
```

### Fish

## 🛠️ 주요 변경사항 (request-transformer.ts 기준)

- **POSTECH GenAI API 전용 메시지 변환기 추가**
  - OpenAI 스타일 메시지를 POSTECH API 포맷으로 자동 변환
  - 첨부파일, 다양한 메시지 타입 지원
- **A2 API 대응**
  - 입력/출력 길이 제한 상향, 최근 메시지 보존 개수 증가
- **코드 리팩토링 및 주석 강화**
  - 타입스크립트 기반 구조화, 상세 주석 추가

> 자세한 구현 내용은 `packages/core/src/client/request-transformer.ts` 파일을 참고하세요.
```fish
echo "alias popilot='node (pwd)/packages/cli/dist/index.js'" >> ~/.config/fish/config.fish
```
> **TIP:** 프로젝트 루트에서 위 명령어를 실행하세요.

---

## 🖥️ 주요 변경사항 (App.tsx 기준)

- **UI/UX 개선:** 입력 프롬프트 및 명령 실행 흐름이 개선되었습니다.
- **명령어 자동완성/도움말 기능 강화**
- **에러 핸들링 및 사용자 피드백 강화**
- **코드 구조 리팩토링 및 컴포넌트 분리**

> 자세한 변경 내역은 `packages/cli/src/App.tsx` 및 커밋 로그를 참고하세요.

---

## 🛠️ 개발 및 테스트

```bash
# 개발 서버 실행
npm run dev

# 테스트
npm test
```
---

## 📄 라이선스

MIT

---

## 🙋‍♂️ 문의


---

## 💡 슬래시 커맨드 안내

Popilot CLI에서는 다양한 슬래시 커맨드를 지원합니다. 주요 커맨드는 다음과 같습니다.

| 커맨드         | 설명                                 |
| -------------- | ------------------------------------ |
| `/run`         | 입력한 명령을 실행합니다              |
| `/help`        | 사용 가능한 커맨드와 도움말을 표시    |
| `/clear`       | 입력 프롬프트를 초기화합니다          |
| `/history`     | 최근 실행한 명령어 목록을 보여줍니다  |
| `/exit`        | CLI를 종료합니다                     |

> **TIP:** 입력창에 `/`를 입력하면 자동완성 기능이 활성화되어 사용 가능한 커맨드를 쉽게 확인할 수 있습니다.
- 이슈 및 PR은 GitHub를 통해 남겨주세요.