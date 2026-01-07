# Popilot

AI 기반 코드 자동화 및 CLI 도구

---

## 프로젝트 구조

popilot/
├── packages/
│   ├── cli/           # CLI 실행 및 UI 관련 소스
│   │   ├── src/
│   │   │   ├── App.tsx           # 메인 앱 컴포넌트 (슬래시 명령어 포함)
│   │   │   ├── ui/InputPrompt.tsx
│   │   ├── package.json
│   │   ├── tsconfig.json
│   ├── core/          # 핵심 로직 및 클라이언트 코드
│   │   ├── src/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   ├── mcp-server/    # 서버 관련 코드
├── README.md
├── 기타 설정 파일

---

## 주요 기능

- **AI 기반 코드 자동화**
- **슬래시 명령어 지원**
  - /run, /edit, /search 등 다양한 명령어로 빠른 작업 수행
  - 명령어 자동완성 및 도움말 기능 내장
- **CLI 인터페이스**
  - 직관적인 터미널 UI
  - 실시간 입력 프롬프트 및 결과 출력

---

## 슬래시 명령어 사용법

Popilot CLI에서는 슬래시(/)로 시작하는 명령어를 입력하여 다양한 작업을 수행할 수 있습니다.

### 예시

- /run <script> : 지정한 스크립트 실행
- /edit <filename> : 파일 편집 모드 진입
- /search <keyword> : 프로젝트 내 키워드 검색
- /help : 사용 가능한 명령어 목록 및 설명 출력

### 자동완성 및 도움말

- 입력창에서 /를 입력하면 사용 가능한 명령어 목록이 자동으로 표시됩니다.
- 각 명령어에 대한 상세 설명은 /help 명령어로 확인할 수 있습니다.

---

## 설치 및 실행

```bash
# 의존성 설치
npm install

# CLI 실행
npm run cli
```

---

## 개발 및 기여

- 주요 코드 위치: packages/cli/src/App.tsx
- 슬래시 명령어 관련 로직: App.tsx 및 ui/InputPrompt.tsx 참고
- Pull Request 및 Issue 등록을 통한 기여 환영

---

## 라이선스

MIT

--

## 환경 변수 설정

- `.env` 파일 예시:

```env
OPENAI_API_KEY=your-api-key
POPILOT_MODE=dev
```

--

## 주요 명령어 요약

| 명령어 | 설명 |
| ------ | ------------------------------------------------ |
| /run <script> | 지정한 스크립트 실행 |
| /edit <filename> | 파일 편집 모드 진입 |
| /search <keyword> | 프로젝트 내 키워드 검색 |
| /help | 명령어 목록 및 설명 출력 |

--

## 기여 가이드

- 코드 스타일: [Prettier](https://prettier.io/) 및 [ESLint](https://eslint.org/) 권장
- 커밋 메시지: [Conventional Commits](https://www.conventionalcommits.org/)
- PR: 기능/버그 단위로 명확하게 작성
- Issue: 재현 방법, 기대 동작, 실제 동작을 상세히 기재

--

## 문의 및 라이선스

- 문의: Issue 등록 또는 maintainer 이메일 활용

--

## 추가 안내 및 참고 자료

- 커뮤니티: GitHub Discussions, Slack 채널 등
- 버그/기능 요청: Issue 등록 후 maintainer와 소통

--

## 업데이트 내역

- 슬래시 명령어 기능 강화 및 설명 추가
- 환경 변수 및 주요 명령어 표 보강
- 기여 가이드 및 문의/라이선스 최신화
- 라이선스: MIT