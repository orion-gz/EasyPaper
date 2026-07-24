# Changelog

EasyPaper의 변경 이력입니다. 이 프로젝트는 커밋 해시 기반 롤링 업데이트를 사용하며,
별도의 버전 번호 대신 병합된 날짜 기준으로 정리합니다.

## 2026-07-24

- feat: main 브랜치 자동 배포 GitHub Actions 워크플로우 추가 (#142)
- fix: 상하로 쌓인 서브패널 그림의 호버 오버레이 잘림 수정 (#141)
- fix: 서브플롯 여러 개로 나뉜 그림의 호버 오버레이가 절반만 보이던 문제 수정 (#140)
- fix: PDF 내보내기에서 markdown 볼드/LaTeX 수식 렌더링 수정 (#139)

## 2026-07-23

- fix: 세션 유지형 번역 프롬프트에서 표 제외 규칙 드리프트 수정 (#138)
- fix: PDF 내보내기에서 긴 번역을 축소해 한 페이지에 강제로 맞춤 (#137)
- feat: 번역 포함 PDF 내보내기를 뷰어처럼 원문·번역 페이지 페어링 (#136)
- feat: Figure/Table/수식 참조 클릭 시 해당 페이지로 이동 (#135)
- feat: 인용/Figure/Table/수식 오버레이 끄기 설정 추가 (#134)
- fix: 수식/벡터 다이어그램 그림 오버레이 정확도 개선 (#133)
- feat: Figure/Table/수식 참조 호버 미리보기 개선 (#132)
- feat: Figure/Table 참조 호버 미리보기 추가 (#131)
- fix: 로그인 생략 설정 섹션 여백 통일 (#130)
- feat: 로그인 상태 유지 및 로그인 생략 기능 추가 (#129)
- feat: 전체 앱 아이콘을 새 디자인(style1)으로 교체 (#128)
- feat: Tauri 데스크탑 앱화 (Windows/macOS/Linux) (#127)
- ci: Tauri 릴리스 워크플로우를 main에 추가 (#126)
- feat: 온보딩 Ollama 모델 다운로드 추천 목록에 Gemma 등 최신 모델 추가 (#124)
- fix: Windows에서 콘솔 코드페이지 인코딩 문제로 백엔드 기동 실패 수정 (#125)
- ci: Tauri 데스크탑 스파이크 워크플로우를 main에 추가 (#123)
- fix: macOS 뷰어 번역 진행 스피너가 타원형으로 찌그러지는 문제 수정 (#122)
- fix: 온보딩 번역 엔진 선택 후 뷰어에 ollama로 표시되는 문제 수정 (#121)
- fix: macOS CLI 미탐지 및 npm 전역 설치 EACCES 문제 해결 (#120)
- fix: 드롭캡/줄내 이어붙음으로 References 헤더를 못 찾던 문제 수정 (#119)
- feat: 본문 인용 오버레이에 (Author, Year) 스타일 지원 추가 (#118)
- fix: Windows에서 Antigravity CLI 설치 스크립트 실패 문제 수정 (#117)

## 2026-07-22

- fix: KaTeX 인용 텍스트 중복/줄바꿈 및 인용 이미지 새로고침 소실 수정 (#116)
- feat: refresh app icon, remove bloated fake-SVG favicon, harden static file serving (#115)
- feat: add app favicon and icon set (#114)
- docs: refresh README with badges, table of contents, and lighter screenshots (#113)
- feat: add CHANGELOG.md and full-history changelog popup (#112)
- fix: system update restart failure and stale frontend build after update (#111)
- feat: add hover tooltip and Google Scholar fallback for citation references (#110)
- refactor: unify changelog UI across settings and update popups (#109)
- feat: separate update check/run buttons and show changelog in settings (#108)
- feat: support CLI-based AI engines in Docker via host credential mounts (#107)
- feat: add Docker containerization support (#106)
- feat: add Gemini 3.6 Flash model to Antigravity provider list (#105)
- feat: add cross-document comparison chat (#104)
- fix: restore flex layout on library filter row after inline style reset (#103)
- fix: prevent library view toggle from overlapping category tags (#102)
- feat: add clickable reference links for numbered citations (#101)
- feat: 번역/하이라이트/밑줄/메모 포함 PDF 내보내기 추가 (#100)
- feat: 라이브러리 전체 검색 기능 추가 (#99)

## 2026-07-21

- feat: 데이터 백업/복원 스크립트 추가 (#98)
- feat: 구조화된 로깅 도입 (콘솔+로테이팅 파일 핸들러, llm_client.py 우선 전환) (#97)
- test: 프론트엔드 Playwright E2E 테스트 스위트 신규 추가 (#96)
- test: 백엔드 pytest 테스트 스위트 신규 추가 (#95)
- feat: 버전 표시에 커밋 날짜 추가 (#94)
- feat: 자동 업데이트 확인 주기 설정 + 변경 로그 팝업 + 업데이트 완료 안내 추가 (#93)
- fix: 업데이트 후 서버 재시작이 Linux+systemd 전용이던 문제 수정 (크로스플랫폼) (#92)
- feat: AI 채팅 답변에서도 텍스트 선택 인용(Ask AI) 기능 추가 (#91)
- fix: 기본 관리자 비밀번호 사용 중이면 서버 시작 시 경고 출력 (#90)
- fix: 설치 SSE 스트림 클라이언트 연결 끊김 시 좀비 프로세스 방지 (#89)
- fix: 번역 job 재시작 시 _running_tasks 추적 경쟁 조건 수정 (#88)
- fix: CLI 채팅 사용량 이중 카운트 수정 (#87)
- fix: CLI stderr 미드레인으로 인한 파이프 버퍼 데드락 가능성 수정 (#86)
- fix: 아이디 변경 시 논문 라이브러리가 사라지던 문제 수정 (#85)
- fix: 문서 영구삭제 시 업로드 원본/캐시 파일이 남던 문제 수정 (#84)
- fix: 문서 전환 시 PDF 렌더링 경쟁 조건으로 이전 문서가 섞여 보이던 문제 수정 (#83)
- fix: 문서 전환 시 채팅 스트림 미취소로 인한 경쟁 조건 수정 (#82)
- fix: CLI 서브프로세스 타임아웃 부재로 인한 세션 락 영구 고착 문제 수정 (#81)
- fix: CLI 실행 실패가 조용히 삼켜져 빈 번역/오분류가 캐시되던 문제 수정 (#80)
- fix: 라이브러리 엔드포인트 문서 소유자 확인 누락(IDOR) 수정 (#79)
- fix: 모든 설치본이 공유하는 고정 SECRET_KEY 기본값으로 인한 세션 위조 취약점 수정 (#78)
- fix: PROJECT_ROOT 하드코딩으로 인한 CLI 서브프로세스 [Errno 2] 실행 오류 수정 (#77)
- fix: CLI 서브프로세스 HOME 환경변수 하드코딩으로 인한 macOS [Errno 45] 오류 수정 (#76)
- feat: 온보딩 엔진 선택을 2단계 마법사(프로바이더→모델)로 개선 (#75)
- fix: CLI 경로 자동 탐지 개선 및 온보딩 다음 단계 안내 추가 (#74)
- fix: Windows에서 claude/codex/agy CLI [WinError 2] 실행 실패 수정 (#73)
- fix: 온보딩 설치 완료 표시, Ollama 감지, 모델 선택기 사용가능 칩 (#72)
- feat: 온보딩에 Antigravity CLI 자동 설치 추가 (#71)
- fix: setup.bat이 Miniforge/Anaconda 파이썬을 자동으로 탐색해 사용 (#70)
- refactor: bat/sh 스크립트를 scripts/ 상위 디렉터리로 통합 (#69)
- refactor: 배치/셸 스크립트를 bat/, sh/ 디렉터리로 분리 (#68)
- feat: 첫 실행 AI 엔진 자동 감지/설치 온보딩 모달 추가 (#67)
- fix: setup.bat의 Windows Store python 별칭 스텁 오인 문제 수정 (#66)
- fix: 배치 파일 더블클릭 시 창이 바로 닫히던 문제 수정 (#65)
- feat: Windows용 배치 스크립트 추가, 셸 스크립트 원상 복구 (#64)
- fix: Windows에서 셸 스크립트 CRLF 실행 오류 수정 (#63)
- refactor: Windows 지원을 Git Bash 호환 방식으로 통일 (#62)

## 2026-07-19

- fix: 라이트 테마 토스트 가독성 및 로그인 화면 곡률 통일 (#61)
- refactor: 전체 디자인 미니멀 리디자인 및 라이브러리 카드 개선 (#60)
- feat: 테마 색상 컬러 피커 추가 및 기본 강조색/버튼 이펙트 변경 (#59)
- refactor: 탭/태그/버튼 색상을 차분한 톤으로 변경 (#58)
- refactor: 라이브러리 탭/버튼 및 로그인 화면 디자인 통일 (#57)

## 2026-07-18

- refactor: 라이브러리 카드/리스트/미리보기 팝업 디자인을 하나의 언어로 통일 (#56)
- fix: 뷰어 진입 시 history 변수명 충돌로 열기 버튼이 응답 없이 실패하던 심각한 버그 수정 (#55)
- perf: 뷰어 진입 시 순차 실행되던 무관한 비동기 작업들을 병렬화 (#54)
- fix: 미리보기 이미지가 잘려서 크게 보이던 문제와 뷰어 진입이 느려지던 문제 수정 (#53)
- feat: 논문 카드 확장 미리보기(제목+abstract 캡쳐) 및 뷰어로의 부드러운 진입 추가 (#52)
- feat: 라이브러리 카드 디자인을 파스텔 투톤 스타일로 재설계하고 리스트 보기 추가 (#51)
- refactor: 라이브러리 카드를 그라디언트/글로우 대신 색인 카드 스타일로 재설계 (#50)
- refactor: 라이브러리 카드에 카테고리 색 아이덴티티와 모던한 마이크로 인터랙션 추가 (#49)
- refactor: 라이브러리 논문 카드 시각 디자인 리파인 (#48)
- feat: 설정 화면에서 Ollama 미설치 시 원클릭 설치 기능 추가 (#47)
- fix: 번역문 볼드 구간으로 문장이 쪼개질 때 호버/클릭 하이라이트가 일부만 표시되는 문제 수정 (#46)
- feat: Codex CLI 기반 번역/채팅/인사이트 스트리밍 provider 추가 (#45)
- fix: 키워드 클릭 하이라이트가 스크롤 중 사라지고 두 번 클릭해야 보이는 문제 수정 (#44)
- fix: 키워드 클릭 하이라이트 실패 시 무반응 대신 오류를 표시하도록 수정 (#43)
- fix: 줌 변경 후 키워드 클릭 하이라이트가 동작하지 않는 문제 수정 (#42)

## 2026-07-17

- fix: 학술/요약 스타일 번역에 번역투 방지 지침 추가 (#41)
- fix: don't literally translate field-conventional technical terms (#40)

## 2026-07-16

- fix: remove "(GRE 수준 단어)" style labels from keyword definitions (#39)
- fix: locate keyword terms in PDF using fuzzy text matching (#38)
- feat: click a keyword term to locate and highlight it in the PDF (#37)
- fix: exclude basic ML terms from keywords tab and restyle insight tabs (#36)
- feat: add keywords/vocabulary and summary tabs to translation panel (#35)
- fix: make pinch/wheel zoom feel smooth during the gesture (#34)
- feat: support pinch-to-zoom in viewer (trackpad + touchscreen) (#33)
- feat: auto-save and restore last reading position in viewer (#32)
- feat: add viewer setting to disable hover-triggered selection tooltip (#31)
- feat: preserve bold and paragraph indentation from PDF into translation (#30)
- fix: recover sentence alignment when LLM drops/merges [S{n}] tags (#29)
- refactor: replace decorative emoji with simple inline SVG icons (#28)

## 2026-07-15

- fix: resolve race conditions in assistant conversation mapping (#27)
- feat: implement document soft-delete, restore, and trash bin control (#26)
- feat: design and position new paper upload button as floating action button (#25)
- fix: resolve AI assistant session persistence and history redundancy (#24)
- fix: 수식 복사 시 LaTeX 문법으로 복사되도록 수정 (번역본 + PDF 원문 패널) (#23)

## 2026-07-13

- fix: correct reading order for two-column PDF pages (#22)
- fix: reuse a single Claude Code CLI session per document (#21)
- Fix/chat session split (#20)
- Feature/sentence matching rebuild (#19)

## 2026-07-11

- Feature/unify cli sessions (#18)

## 2026-07-07

- Feat/claude streaming (#17)

## 2026-07-06

- Feat/library history (#16)

## 2026-07-03

- Fix/ai assistant (#15)
- Ux refinement (#14)

## 2026-07-02

- Ux refinement (#13)

## 2026-06-30

- Fix/math latex rendering (#12)
- Feat/sentence matching fix (#11)
- build: force add updated dist/index.html to align with new build assets (#10)

## 2026-06-25

- Feat/figure ask (#9)
- Feat/sentence matching (#8)
- fix: translation suffix mismatch fallback logic to prevent translatio… (#7)
- fix: retrieve real-time quota usage from Antigravity cloud server (#6)
- Feat/advanced settings (#5)
- Feat/advanced settings (#4)
- fix: 뷰어 뒤로가기 알림 팝업 제거 및 번역체 경어체(~합니다)로 통일 (#3)

## 2026-06-24

- feat: 서비스 포트, 호스트, agy CLI 절대 경로 매개변수화 및 .env 설정 추가 (#2)
- fix: 라이트 테마 UI 색상 및 가독성 개선 (#1)
