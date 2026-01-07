# Popilot
> **POSTECH 유저를 위한 AI 코드 자동화 및 CLI 도구**
> **2026년 1월 기준 최신 Popilot 프로젝트 안내**

v ___ _ _ 
 \('v')/ | _ \___ _ __(_) |___| |_ 
 ( @ @ ) | | _/ _ \ '_ \ | / _ \ _|
 \ \|/ |_| \___/| .__/_|_\___/\__|
 |=| |_|
 [___]

Popilot는 모듈화된 구조의 TypeScript 기반 프로젝트로, CLI, Core, MCP Server 등 다양한 패키지로 구성되어 있습니다.

## 패키지별 주요 기능

- **cli**: 명령줄 인터페이스 및 자동화 도구
- **core**: 공통 비즈니스 로직 및 유틸리티
- **mcp-server**: 서버 애플리케이션
- **examples**: 예제 및 테스트 코드
## 프로젝트 구조

## 사용방법

### SSO 로그인 기능 개선 안내
- 2026년 1월부로 SSO(POSTECH 통합인증) 로그인 프로세스가 개선되었습니다.
- 기존 대비 보안이 강화되었으며, 최초 로그인 시 통합인증 포털로 리다이렉트됩니다.
- 자세한 사용법은 아래 예시 및 공식 문서를 참고하세요.

popilot/
-- packages/
- -- cli/ # 커맨드라인 인터페이스
- -- core/ # 핵심 로직 및 유틸리티
- -- mcp-server/ # 서버 컴포넌트
- -- examples/ # 예제 및 테스트 코드
-- README.md
- **모듈별 테스트 및 예제 제공** (packages/examples)
- **유닛/통합 테스트 지원** (Jest, Vitest 등)
- **패키지별 주요 기능 요약**
    - **cli**: 명령줄 인터페이스 및 자동화 도구
    - **core**: 공통 비즈니스 로직 및 유틸리티
    - **mcp-server**: 서버 애플리케이션
    - **examples**: 예제 및 테스트 코드
- **예제 및 테스트**: `packages/examples` 폴더에서 다양한 샘플과 테스트 케이스를 확인할 수 있습니다.
- **테스트 실행**: 모든 패키지에서 `npm run test`로 유닛/통합 테스트를 실행할 수 있습니다.
- **멀티 패키지 구조 지원** (cli, core, mcp-server 등)
- **examples**: 예제 및 테스트 코드 (packages/examples)
- **테스트 지원**: 모든 패키지에서 'npm run test'로 유닛/통합 테스트 실행
## 빠른 시작

1. **의존성 설치**
   ```bash
   npm install
   ```
2. **전체 패키지 빌드**
   ```bash
   npm run build
   ```
3. **CLI 실행**
   ```bash
   cd packages/cli
   npm start
   ```
4. **서버 실행**
   ```bash
   cd packages/mcp-server
   npm start
   ```

## 테스트 및 예제 실행

- 모든 패키지에서 아래 명령어로 유닛/통합 테스트를 실행할 수 있습니다.
  ```bash
  npm run test
  ```
- 예제 및 샘플 코드는 `packages/examples` 폴더에서 확인할 수 있습니다.
1. **의존성 설치**
   ```bash
   npm install
   ```

### [SSO 로그인 기능 개선 안내]
- 2026년 1월부로 SSO(통합인증) 로그인 기능이 개선되었습니다.
- 기존 대비 인증 속도 및 안정성이 향상되었으며, POSTECH 포털 계정으로 간편하게 로그인할 수 있습니다.
- 자세한 사용법은 아래 예시 및 공식 문서를 참고해 주세요.
2. **전체 패키지 빌드**
   ```bash
   npm run build
   ```
3. **CLI 실행**
   ```bash
   cd packages/cli
   npm start
   ```
4. **서버 실행**
   ```bash
## 빠른 시작

1. 의존성 설치
   bash
   npm install
2. 전체 패키지 빌드
   bash
   npm run build
3. CLI 실행
   bash
   cd packages/cli
   npm start
4. 서버 실행
   bash
   cd packages/mcp-server
   npm start

## 테스트 실행

- 모든 패키지에서 아래 명령어로 테스트 가능
  bash
  npm run test
   cd packages/mcp-server
   npm start
   ```
- **확장 가능한 서버 연동 기능**
- **최신 명령어 및 자동화 엔진 탑재**
-- package.json
-- 기타 설정 파일

## 주요 패키지

- **cli**: 명령어 기반 도구 제공

```bash
# 의존성 설치
npm install
|--|--|
| /run <script> | 스크립트 실행 |
| /test | 모든 패키지 테스트 실행 |
| /deploy | 배포 |
| /help | 도움말 |
| /lint | 코드 스타일 검사 |
| /format | 코드 자동 포맷팅 |
npm install

# CLI 실행 예시
## 스크립트

- `npm run build` : 전체 패키지 빌드
- `npm run test` : 전체 테스트 실행

## 기여 방법

1. 저장소 Fork
2. 브랜치 생성 (feature/your-feature)
3. Pull Request 제출

## 라이선스

MIT
cd packages/cli
npm start

## 주요 명령어 요약

| 명령어 | 설명 |
|--|--|
- 정기적으로 의존성 및 보안 업데이트는 CHANGELOG.md에 기록됩니다.
| /deploy | 배포 |
| /help | 도움말 |
# MCP 서버 실행 예시
cd packages/mcp-server
npm start
```

## 개발 환경

## 커뮤니티 및 문의
- 커뮤니티 채널: Slack/Discord 안내는 내부 문서 참고
- 프로젝트 관련 문의는 GitHub Discussions 또는 Issues를 활용하세요.
3. 코드 스타일 준수 (Prettier)

## TurboRepo로 모노레포 관리
- 각 패키지별 독립 개발 및 실행 가능
- 공통 의존성 및 빌드 관리

- 정기적으로 의존성 및 보안 업데이트
- 주요 변경사항은 CHANGELOG.md에 기록
## 코드 스타일
## FAQ
- 코드 스타일: Prettier 적용, 일관된 포맷 유지
- 기여 방법: GitHub 이슈/PR 등록, 최신 브랜치 리베이스
- Prettier 적용
- 일관된 코드 포맷 유지

## 이슈 및 PR
- GitHub 이슈 등록 후 토론
- PR 생성 시 최신 브랜치로 리베이스

## 문의
## 커뮤니티
- 커뮤니티 채널: Slack/Discord 안내는 내부 문서 참고
- GitHub Discussions, Issues, PR 환영
- 내부 Slack/Discord 채널 운영 시 해당 채널 안내
- 프로젝트 관련 문의는 GitHub Discussions 또는 Issues 활용

## 라이선스
- MIT License

## 버전 정보 및 유지보수

- 최신 버전: 2026.01
- 주요 변경사항은 CHANGELOG.md 참고
- 정기적으로 의존성 및 보안 업데이트