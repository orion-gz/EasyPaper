# Changelog

EasyPaper의 변경 이력입니다. 이 프로젝트는 커밋 해시 기반 롤링 업데이트를 사용하며,
별도의 버전 번호 대신 병합된 날짜 기준으로 정리합니다.

## 2026-08-11

- feat: 노트·AI 채팅 Markdown 렌더링과 지식 그래프 구조화 논문 태그 추가 (#408, #416)
- feat: 라이브러리 항목의 열기·선택·이름 편집 상호작용 개선 (#412)
- fix: PDF 제목 추출·번역 초기화와 수동 편집 제목의 영속성 보장 (#409, #413, #414, #415, #417)
- fix: 노트 카드 색상, 대시보드 AI 인사이트 제목, Reading Score 유지 정합성 개선 (#406, #407, #410)
- fix: AI 채팅 미리보기 범위를 제한하고 카드 뷰 액션 버튼 노출 보장 (#411, #418)

## 2026-08-10

- ci: AppImage linuxdeploy 실패가 Linux deb·rpm 배포를 막지 않도록 번들 대상 분리 (#404)
- ci: Linux Tauri 릴리스에서 필수 시스템 패키지 설치가 건너뛰어지던 조건 수정 (#402)
- fix: PDF·AI 채팅 상호작용과 유휴 상태를 기준으로 읽기 시간 분류 정확도 개선 (#398)
- fix: 의미 있는 페이지 방문·상호작용을 기준으로 Reading Score, EMA, 타임라인 정합성 보정 (#400)
- fix: Windows에서 HTML5 드래그앤드롭이 동작하도록 Tauri 기본 드롭 핸들러 비활성화 (#399)

## 2026-08-09

- feat: 라이브러리에서 마우스 드래그로 여러 논문을 선택하고 Ctrl/Cmd 조합 선택을 지원 (#395)
- fix: 중첩 폴더 삭제 시 하위 폴더·논문을 함께 처리하고 폴더 탐색·선택·이동 데이터 정합성 개선 (#393, #394)
- feat: 번역 완료 후 페이지 인사이트 자동 생성 및 용도별 AI 모델 설정 추가 (#364)
- security: `python-multipart` 취약점 대응, 고비용 API 레이트리밋 및 관리자 전용 시스템 업데이트 적용 (#370, #384, #387)
- security: 상태 변경 CLI 설치 API를 POST로 제한하고 Gemini API 키·런타임 오류 노출 차단 (#386, #389)
- fix: 사용자명 변경 시 연관 데이터·폴더를 함께 마이그레이션하고 LLM 사용량을 성공한 호출에만 기록 (#378, #390)
- perf: 지식 그래프 레이아웃·카테고리 엣지·OpenAlex 검증 및 비교 세션 조회 성능 개선 (#374, #375, #376, #377)
- perf: 공유 페이지 데이터 TTL 캐시와 Reading History 증분 렌더링 적용 (#379, #380)
- fix: 토스트·모달·라이트 테마 접근성과 SPA 페이지 전환 stale render race 개선 (#371, #372, #373, #381)
- refactor: 문서 소유권 검사, CLI 설치 스트림 및 LLM 스트림 오류 처리를 공통화 (#383, #385, #388)
- test: 프론트엔드 단위 테스트 실행 스크립트와 CI 게이트 추가 (#382)

## 2026-08-07

- feat: 라이브러리 폴더 트리 관리 및 카드형 폴더 UI 추가 (#363, #365)
- fix: 라이브러리 폴더 생성·이름 변경·삭제·실행 취소·키보드 조작·탐색·드래그 UX 개선 (#366, #367, #368, #369)

## 2026-08-04

- fix: 대시보드 무한 로딩 해결 및 전체 읽은 페이지 수 계산 보정 (#336)
- fix: 대시보드와 Reading History 간 통계 계산 방식 일관성 통일 (#335)
- fix: 전체 및 최근 통계의 읽은 논문 수 일관성 확보 (#334)
- fix: Reading History 페이지 무한 로딩 문제 해결 (#333)
- fix: Reading History 타임라인 조회 실패 시 폴백 추가 (#332)
- fix: Reading History 상시 렌더링 보장 및 대시보드 카드 타이틀 '활동 요약'으로 변경 (#331)
- feat: Reading Analytics 시스템 구현 및 대시보드·History 카드 통합 (#328, #330)
- fix: 2분 이내 연속 타임라인 읽기 세션 인플레이스 갱신 및 병합 (#326)
- fix: 라이브러리 상세 사이드바 불투명도 및 호버 오버레이 투명도 개선 (#327)
- fix: 타임라인 활동 카드 및 좌측 원형 아이콘 수직 중앙 정렬 (#325)
- feat: Reading History 기간 필터 칩(7일 등) 추가 (#324)
- refactor: AI Chats 헤더 중복 타이틀 및 검색 상자 정리 (#323)
- fix: 라이브러리 헤더 서브타이틀 및 버튼 레이아웃 정렬 (#322)
- feat: EMA 기반 읽기 속도 추정 및 독서 활동 히트맵/누적 페이지 계산 고도화 (#313, #317, #321)
- refactor: AI 추천 논문 리스트 높이 확장 및 다시 받기 버튼 헤더 이동 (#318, #319)
- refactor: 대시보드 카드 행 높이 통일 및 빈 공간 제거 (#312, #314, #315, #316)
- feat: Research Graph 개념 히트맵 논문×개념 매트릭스 고도화 및 LLM 점수 적용 (#310, #311)
- fix: Research Graph 타임라인 탭 제거 및 오버레이 인식 범위 수정 (#306, #307, #308, #309)

## 2026-08-03

- feat: AI 추천 논문 개수 확대 및 다시 받기 버튼 추가 (#305)
- feat: 채팅 인용 이미지를 문서별 디렉터리에도 저장해 기기 간 동기화 지원 (#304)
- feat: AI 인사이트를 지도교수 관점 조언으로 개선 및 LLM 기반 전환 (#299, #303)
- fix: 대시보드 최근 읽은 논문 날짜 업데이트 반영 및 최근 질문 클릭 시 AI Chats 드로어 연동 (#301, #302)
- fix: AI Chats 드로어 인용 표시 및 배경 불투명도 수정 (#296, #300)
- fix: LLM 프로바이더 모델 선택 목록 최신 버전 업데이트 (#295)
- feat: AI Chats 우측 드로어 기능, 뷰어 없는 독립 대화 화면 및 추천 결과 캐싱 (#291, #292, #293, #294)
- feat: EasyPaper 사이드바 기반 Research Workspace 리디자인 (#289, #290)

## 2026-08-02

- refactor: 지식 그래프 대시보드 UI 카드형 리디자인 및 개념 히트맵 grid 반응형 개선 (#286, #287, #288)
- feat: 지식 그래프 타임라인 카드 클릭 시 해당 논문 대화 세션으로 이동 (#284, #285)
- fix: 수식 크롭 오버레이 정확도 개선 및 인접 문단/제목 오버레이 흡수 방지 (#278, #279, #280, #281, #282, #283)

## 2026-08-01

- feat: 개인화된 지식 그래프(Research Graph) 3차/4차 구현 및 노드 상세 패널 기능 추가 (#274, #275, #276, #277)

## 2026-07-31

- feat: 개인화된 지식 그래프(Research Graph) 1차/2차 구현 추가 (#272, #273)
- fix: AI 추천 질문 칩 LaTeX 수식 렌더링 미적용 수정 (#271)
- fix: 메모 커넥터 점선이 드래그 선택 범위 시작점에서 그려지도록 수정 (#270)
- fix: 문장 드래그 선택 후 메모 생성 시 선택 범위만 하이라이트되도록 수정 (#269)
- fix: 논문 제목 추출 시 저자명/섹션 헤더 섞임 수정 (#268)
- chore: 데스크톱 앱 버전을 0.1.14로 올리고 CHANGELOG.md에 #259~#266 변경 이력 반영 (#267)
- fix: 목차 아이콘에 빠진 stroke-linecap round로 중앙 정렬 어긋남 수정 (#266)
- fix: 툴바 버튼 마진 통일 및 아이콘 중앙 정렬 (모든 위치) (#265)
- fix: 세로 툴바 버튼 가운데 정렬, 페이지 카운터 크기, 줌 버튼 순서 수정 (#264)

## 2026-07-30

- fix: 좌/우 세로 툴바를 컴팩트한 flat 아이콘 스타일로 재정리 (#263)
- fix: 좌/우 세로 툴바 버튼 모양/찌그러짐 수정 (진짜 원인 발견) (#262)
- fix: 좌/우 세로 툴바에서 페이지 표시 박스가 줌 컨트롤과 겹치던 문제 수정 (#261)
- fix: 좌/우/하단 툴바 위치에서 floating 스크롤 버튼·케밥 메뉴 겹침 수정 (#260)
- fix: 툴바 자동 숨김 위치별 방향 및 doc-title-edit-btn 노출 버그 수정 (#259)
- fix: 툴바 위치(하단/왼쪽/오른쪽) 설정 시 케밥 메뉴·목차 사이드바 렌더링 버그 수정 (#257)
- fix: 읽기 전 브리핑 모달 flicker/버튼 정렬/LaTeX·MD 렌더링/약어 표기 수정 (#256)
- fix: CLI provider(claude_code/codex/antigravity)가 문서별 격리 폴더를 cwd로 쓰도록 수정 (#255)
- fix: 설정 저장 버튼 삭제 및 자동 저장으로 변경 (#254)

## 2026-07-29

- fix: codex/ollama provider에서도 캡처 이미지가 실제로 전달되도록 수정 (#253)
- fix: antigravity(agy) provider에서 캡처 이미지가 실제로 전달되지 않던 문제 수정 (#252)
- fix: AI 어시스턴트 캡처 이미지가 실제로 LLM에 전달되지 않던 문제 수정 (#251)
- fix: 개요 탭 콘텐츠가 길어지면 브리핑 탭 바가 짓눌려 안 보이던 문제 수정 (#250)
- fix: 브리핑 첫 노출 시 탭 바/개요 패널이 안 보이던 문제 - 리페인트 범위 확대 (#249)
- fix: 읽기 전 브리핑 모달 첫 노출 시 탭 바가 안 보이던 문제 수정 (#248)
- hotfix: antigravity 브리핑 생성에서 --effort 강제 제거 + 실패 재시도 쿨다운 (#247)
- fix: 브리핑 LLM 생성 실패 시 빈 결과가 캐시에 영구 저장되던 문제 수정 (#246)
- fix: 그림/표/수식 참조 미리보기 툴팁의 빈 여백 제거 (#245)
- fix: 오버레이 드래그 리사이즈는 자유 형태로 되돌리고 면적 전파만 유지 (#244)
- fix: 오버레이 리사이즈 시 면적 증가율을 다른 오버레이에도 전파 (#243)
- fix: fig/table/equation 오버레이 리사이즈 시 이미지 비율 유지 (#242)

## 2026-07-28

- fix: 툴바 자동 숨김 시 뷰어/어시스턴트 패널 상단 여백 남는 문제 수정 (#240)
- fix: 추천 질문 새로고침 캐싱 및 채팅 버블 radius 축소 (#239)
- fix: 일반 설정의 마지막 체크박스를 토글 스위치로 통일 (#238)
- fix: 케밥 메뉴 번역 모델 라벨 세로 배치 버그 수정 (#237)
- fix: 어시스턴트 패널-floating 스크롤 버튼 겹침 수정 (#236)
- feat: 번역 시 vision 지원 provider에 페이지 이미지 첨부해 수식 정확도 개선 (#235)
- feat: 일반 설정 메뉴 checkbox를 toggle switch로 변경 (#234)
- feat: 툴바 위치 설정 기능 추가 (위/아래/왼쪽/오른쪽) (#233)
- feat: 우측 하단 floating 스크롤 버튼 추가 (#232)
- feat: 툴바 추가 메뉴(케밥)로 번역/메모/테마 관련 항목 재구성 (#231)
- feat: 스크롤 방향에 따른 상단 툴바 자동 숨김/표시 (#230)
- feat: 번역 모드 설정 추가 (자동/번역창 펼칠 때/스크롤 시) (#229)
- feat: AI 어시스턴트 답변에 추천 후속 질문 3개 표시 (#228)
- fix: 참조 미리보기 툴팁 리사이즈 시 이미지 비율 유지 (#227)
- feat: 읽기 전 브리핑에 다시 생성하기 기능 추가 (#226)
- fix: 메모 색상 하이라이트 미동기화 및 접기 UI 빈 공간 버그 수정 (#225)
- fix: 브리핑 생성이 리버스 프록시 타임아웃에 걸려 실패하는 문제 수정 (#224)
- feat: 읽기 전 브리핑에 연구 계보/파인만 설명/실험 흐름/용어집 추가 (#223)
- fix: 참고문헌 목록의 저자-연도 스타일이 2단 레이아웃에서 통째로 뭉쳐 파싱되던 문제 수정 (#222)
- feat: Figure/Table/Equation 참조 감지 로직을 다양한 표기 스타일로 확장 (#221)
- feat: 인용(Citation) 오버레이 감지 로직을 다양한 스타일로 확장 (#220)

## 2026-07-27

- feat: 연관 논문 그래프를 참고문헌 매칭 대신 LLM 추천 + 실존 검증 방식으로 개선 (#217)
- design: 읽기 전 브리핑 모달을 이모지 대신 아이콘 배지 기반으로 재디자인 (#216)
- fix: 참고문헌 링크 조회를 Semantic Scholar에서 OpenAlex로 교체 (#215)
- perf: 라이브러리 목록/문서 열기 성능 개선 (N+1 쿼리, 미캐싱 이미지 추출, 프론트 중복 요청 제거) (#214)
- feat: 논문을 처음 열 때 뜨는 "읽기 전 브리핑" 기능 추가 (#213)
- fix: Claude Code CLI 세션 격리 시 인증 실패 및 stderr 유실 버그 수정 (#212)
- feat: 캡처 즉시 인용 및 참조 미리보기 툴팁 리사이즈 기능 추가 (#211)
- perf: 서버 시작 시 미완료 잡이 있는 문서만 세션으로 즉시 복원하도록 변경 및 PDF 텍스트 추출 결과 디스크 캐싱 추가 (#210)
- feat: 감지된 그림/표 오버레이 박스를 드래그로 크기 조절할 수 있는 기능 추가 (#209)
- fix: 표 캡션 방향 오판단으로 인접한 두 표가 하나로 병합되는 회귀 버그 수정 (#208)
- fix: 표 캡션이 표 아래에 있는 논문에서 오버레이 감지 실패하는 문제 수정 (#207)
- fix: macOS 데스크탑 앱 업데이트 설치 시 모듈 임포트 실패 오류 수정 (#205)

## 2026-07-26

- fix: 지울 대상 없는 선택엔 지우기 버튼 숨기고 삭제 후 Ctrl+Z 복원 기능 추가 (#202)
- fix: 어노테이션 호버 툴팁의 삭제 범위 및 메모 삭제 불가 버그 수정 (#201)
- fix: segmentPdfElements 내부의 메모 렌더링 호출이 폴백 세그멘테이션 위치 튐을 막지 못하던 문제 수정 (#200)
- fix: 번역 로딩 중 메모 위치가 잠깐 어긋나던 버그 수정 및 메모 색상별 하이라이트 적용 (#199)
- fix: 텍스트 레이어 재세그멘테이션 시 메모 하이라이트가 복구되지 않던 죽은 코드 제거 (#198)
- fix: 번역 완료 시 메모 하이라이트가 사라지던 버그 수정 및 주석 리스트 펼쳐보기 추가 (#197)
- feat: 라이브러리에 메모/하이라이트/언더라인 조회 기능 추가 (#196)
- feat: 논문 뷰어에 메모 접기/숨기기/전체 숨기기 기능 추가 (#195)
- fix: 채팅 세션 탭 이름 정리 및 논문 열람 성능 개선 (#194)
- feat: 라이브러리에 AI 어시스턴트/논문 비교 채팅 세션 조회 기능 추가 (#193)

## 2026-07-25

- feat: 데스크톱 앱 업데이트 확인 주기 설정 추가 및 macOS/Windows 실행 방법 문서화 (#191)
- fix: 논문 비교 선택 모드에서 열기 버튼 클릭 시 선택 대신 뷰어로 이동하던 문제 수정 (#190)
- fix: 비교 채팅에서 라이브러리/뷰어/로그인 화면으로 돌아갈 때 compare 화면이 겹쳐 남는 문제 수정 (#189)
- feat: 데스크톱 앱 업데이트 발견 시 팝업 알림 및 주기적 재확인 추가 (#187)
- fix: 2단 레이아웃 논문에서 참고문헌 목록의 대부분 항목이 파싱되지 않던 문제 수정 (#185)
- feat: 레퍼런스 오버레이가 다양한 본문 인용 표기와 참고문헌 목록 항목 자체를 감지하도록 개선 (#182)
- fix: 라이브러리 화면에서 번역 진행률 프로그레스 바가 갱신되지 않던 문제 수정 (#181)

## 2026-07-24

- fix: kill_backend_sidecar 커맨드에 ACL 권한이 없어 업데이트 설치 시 sidecar 종료가 조용히 실패하던 문제 수정 (#179)
- fix: 세로로 붙은 표들이 서로의 캡션에 잘못 매칭되어 오버레이가 과도하게 크롭되던 문제 수정 (#178)
- fix: 촘촘히 이어진 여러 표가 하나의 오버레이로 합쳐지는 문제 수정 (#176)
- fix: 자동 업데이트 설치 시 Windows에서 sidecar DLL 잠금으로 실패하던 문제 수정 (#174)
- fix: 앱 버전의 -beta.N prerelease 접미사가 Windows MSI 빌드를 깨뜨리던 문제 수정 (#173)
- fix: 데스크톱 앱 버전을 0.1.1-beta.1로 올려 업데이터가 새 버전을 감지하도록 수정 (#172)
- fix: Figure/Table/Equation 참조 번호가 로마 숫자인 경우 오버레이 매칭 실패 수정 (#171)
- fix: Windows에서 cmd /c 래핑이 agy.exe 프롬프트의 개행 이후를 잘라먹던 문제 수정 (#170)
- fix: Tauri 업데이터 ACL 누락 및 업데이트 버튼 줄바꿈 깨짐 수정 (#169)
- fix: Windows에서 Antigravity 설치 성공을 오탐 실패로 표시하던 문제 수정 (#168)
- fix: start.bat의 PowerShell 정규식 큰따옴표 이스케이프로 cmd.exe 실행 실패 수정 (#167)
- fix: 데스크톱 앱 아이콘을 웹과 동일한 style1 디자인으로 재생성 (#166)
- docs: README에 데스크톱 앱 다운로드/설치 가이드 및 실제 스크린샷 반영 (#165)
- fix: Claude Code/Antigravity CLI 번역 세션에 도구 사용 제한 적용 (#163)
- fix: 업로드 파일 크기 제한을 스트리밍 방식으로 검사 (#162)
- feat: 오버레이 캡션에 원문 볼드 서식 유지 (#161)
- fix: 캐시/잡 상태 파일을 원자적으로 쓰도록 변경 (#160)
- fix: SKIP_LOGIN 경고 문구에 강력한 관리 기능 노출 명시 (#158)
- fix: 번역 진행 상황 폴링이 겹쳐 실행되는 문제 수정 (#157)
- fix: 세션/문서 기반 엔드포인트에 소유자 검증 일관되게 적용 (#156)
- fix: 평문 비밀번호 비교를 타이밍 세이프하게 수정 (#155)
- fix: 로그인에 무차별 대입(brute-force) 방어 추가 (#154)
- fix: AI 채팅/메모/체인지로그 렌더링에서 마크다운 출력 미살균으로 인한 XSS 방지 (#153)
- fix: PDF 원문 드래그 선택 중 reference/fig/table/eq 오버레이 노출 방지 (#152)
- fix: 번역 시 그림 내부 텍스트가 본문에 섞여 들어가는 문제 수정 (#149)
- fix: 릴리스 CI 파이프라인 개선 - 자동 게시, macOS Intel 빌드, 커밋 기반 노트 (#148)
- feat: Tauri 데스크탑 앱에 실제 업데이트 설치 플로우 구현 (#147)
- feat: 정보 탭에 GitHub 저장소 카드 추가 (#146)
- feat: 어시스턴트 모델을 번역 모델과 동일하게 사용하는 체크박스 추가 (#145)
- feat: 설정 모달에 정보 탭 추가 및 시스템 업데이트 섹션 이동 (#144)
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
