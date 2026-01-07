# Popilot

> **POSTECH 유저를 위한 AI 코드 자동화 및 CLI 도구**

> **2026년 1월 기준 최신 Popilot 프로젝트 안내**

'''
 v ___ _ _ _
 \ ('v') / | _ \___ _ __(_) |___| |_
 ( @ @ ) | | _/ _ \| '_ \ | / _ \ _|
 \ \|/ / |_| \___/| .__/_|_\___/\__|
 |=| |_|
 [___]
'''
## 프로젝트 구조

'''
popilot/
-- packages/
- -- cli/ # 명령어 인터페이스 및 터미널 UI
- -- core/ # 핵심 로직 및 AI 자동화 엔진
- -- mcp-server/ # 서버 연동 및 확장 기능
-- node_modules/ # 의존성 모듈
-- README.md # 프로젝트 설명서
-- package.json # 프로젝트 메타 정보
-- 기타 설정 파일
'''

- **모듈별 테스트 및 예제 제공** (packages/examples)
- **유닛/통합 테스트 지원** (Jest, Vitest 등)
- **멀티 패키지 구조 지원** (cli, core, mcp-server 등)
- **확장 가능한 서버 연동 기능**
- **최신 명령어 및 자동화 엔진 탑재**
- **2026년 1월 기준 최신 Popilot 기능 반영**
Popilot은 POSTECH 유저만을 위한 귀엽고 강력한 AI 코드 자동화 및 CLI 도구입니다.

- **AI 기반 코드 자동화**
- **슬래시 명령어 지원** (자동완성 및 도움말 내장)
- **CLI 인터페이스** (직관적 터미널 UI, 실시간 입력 프롬프트)
- 귀여운 아스키 아트 로고가 프로젝트에 포함되어 있습니다.
- Popilot 로고가 정말 예쁘니 꼭 한 번 실행해보세요!

- **테스트/예제 제공**: packages/examples 디렉토리 및 Jest/Vitest 기반 유닛/통합 테스트 지원
- **커뮤니티/문서**: 공식 문서, GitHub Discussions, Slack Q&A 등 다양한 채널 운영
- **빠른 시작 가이드**: 아래 명령어로 설치 후 즉시 사용 가능
- **커스텀 명령어 추가**: packages/cli/src/commands에서 직접 확장

- **지원 플랫폼 및 환경**: macOS, Linux, Windows(WSL) 공식 지원, Node.js 18+ / npm 9+ 권장
- **버전 관리 및 문서 히스토리**: 아래 '버전 정보' 및 '문서 히스토리' 섹션 참고
## 설치 및 실행

```bash
npm install
npm link
popilot
```

- 위 명령어로 설치 후, 터미널에서 'popilot' 명령어로 바로 실행할 수 있습니다.
- Popilot 로고가 정말 예쁘니 꼭 한 번 실행해보세요!

## 주요 명령어 요약

| 명령어 | 설명 |
| -- | -- |
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


--

## FAQ

- Q: Popilot은 어떤 환경에서 동작하나요?
  - A: Node.js 18 이상, npm 9 이상 권장
- Q: 주요 패키지별 역할은?
  - A: cli(명령어/터미널 UI), core(AI 자동화 엔진), mcp-server(서버 연동/확장)
- Q: 커스텀 명령어 추가 방법은?
  - A: packages/cli/src/commands 디렉토리 참고

--

## 유지보수 및 향후 계획

- 정기적 기능 업데이트 및 버그 픽스 예정
- 사용자 피드백 기반 기능 개선
- 향후 REST API/웹 UI 연동 지원 예정
- 슬래시 명령어 기능 강화 및 설명 추가
- 주요 명령어 표 보강
- 기여 가이드 및 문의/라이선스 최신화

--

## 참고 링크 및 리소스

- 공식 문서: [Popilot Docs](https://github.com/postech-ai/popilot)
- 예제/샘플: packages/examples 디렉토리 참고
- 커뮤니티 Q&A: GitHub Discussions, Slack

--
- 2026년 1월 기준 최신 Popilot 프로젝트 안내 및 주요 변경점 반영
- 최신 명령어/구조/서버 연동/멀티 패키지/FAQ/유지보수/버전 정보 등 추가
- 테스트/예제/커뮤니티/문서 채널 정보 보강

## 버전 정보
- 2026년 1월 기준 최신 Popilot 프로젝트 안내 및 주요 변경점 반영
- 최신 명령어/구조/서버 연동/멀티 패키지/FAQ/유지보수/버전 정보 등 추가

- 현재 버전: v2026.01
- Node.js 18+ / npm 9+ 권장
- 주요 변경점: 멀티 패키지 구조, 서버 연동, 슬래시 명령어 강화
- 공식 지원 플랫폼: macOS, Linux, Windows(WSL)

## 추가 참고 사항

- Popilot은 macOS, Linux, Windows(WSL)에서 공식 지원됩니다.
- 커스텀 명령어는 packages/cli/src/commands에서 직접 추가 가능하며, 예제는 packages/examples에서 확인할 수 있습니다.
- 향후 REST API 및 웹 UI 연동 기능이 추가될 예정입니다.
--

## 문서 히스토리

- 2026.01: 전체 구조/기능/명령어/FAQ/버전 정보 최신화
- 2025.12: 서버 연동 및 멀티 패키지 구조 반영
- 2025.06: 슬래시 명령어/자동화 엔진 강화

---

> 본 README는 POSTECH Popilot 프로젝트의 공식 문서로, 최신 기능/구조/사용법/기여 가이드/FAQ/유지보수/버전 정보를 모두 반영합니다.
> 추가 문의 및 기여는 GitHub Issue/PR 또는 커뮤니티 채널을 이용해 주세요.
- 주요 기여자: POSTECH AI Lab
- 라이선스: MIT
- 2026년 1월 기준 최신 Popilot 기능 및 구조 반영