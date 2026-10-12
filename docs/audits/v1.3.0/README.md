# 1.3.0 배포 전 UI/UX 상호작용 조사

- 조사일: 2026-10-11
- 기준: `main`의 `6d9b2dbb6aec3bb6c17282284306f3c37f8e028d` (루트 패키지 버전 표기는 아직 1.2.1)
- 범위: 라이브러리/검색/폴더/휴지통, 노트, 채팅 입력, 확인창, 모드·언어·탭 전환, 기존 브라우저 회귀 테스트
- 방식: 실제 프론트엔드 빌드 + Playwright API 모킹, 비동기 응답 지연·HTTP 오류 주입, 코드 경로 추적, 서버 함수 격리 실행
- 이 PR은 조사와 재현 자료만 포함한다. 제품 코드 수정은 포함하지 않는다.

## 배포 판단

**휴지통의 삭제 범위 불일치와 목록 응답 경합은 배포 전 수정이 필요하다.** 화면에서 보이지 않는 다른 모드의 문서를 영구 삭제할 수 있다. 목록 응답 경합도 먼저 수정하고, 아래 P2 상호작용 결함을 함께 회귀 검증하는 것을 권장한다.

P1은 데이터 손실 또는 잘못된 파괴적 작업으로 이어질 수 있는 문제, P2는 사용자 흐름을 방해하는 기능 결함이다. 이 우선순위는 영향도에 대한 조사 판단이다.

## 확인된 결함

### UX-01 · P1 · 모드별 휴지통 비우기가 다른 모드 문서까지 영구 삭제

- 재현: 연구 모드와 일반 문서 모드의 휴지통에 각각 문서를 넣는다. 연구 모드 휴지통만 연 뒤 `휴지통 비우기`를 승인한다.
- 기대: 현재 표시된 연구 문서만 삭제하거나, 다른 모드까지 삭제하는 범위를 확인창에 명시한다.
- 실제: 조회는 `document_mode=research`로 필터링되지만 삭제는 모드 없이 사용자 전체 휴지통을 순회한다. 일반 문서 모드의 보이지 않는 문서도 복원할 수 없게 된다.
- 근거: [frontend/src/main.js:3288](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L3288), [frontend/src/library.js:423](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/library.js#L423), [backend/routers/library.py:193](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/backend/routers/library.py#L193), [backend/routers/library.py:208](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/backend/routers/library.py#L208).
- 검증: 실제 라우터 함수를 AST로 추출해 가짜 문서·삭제 함수로 실행했다. 화면 목록은 `['research-trash']`, 영구 삭제 대상은 `['research-trash', 'general-trash']`였다. 실제 DB나 사용자 파일을 삭제하지 않았다.
- 수정 방향: 확인창의 범위, DELETE API의 `document_mode`, 서버 조회 조건을 일치시킨다. 두 모드의 문서를 함께 둔 회귀 테스트가 필요하다.

### UX-02 · P1 · 늦은 라이브러리 응답이 현재 탭의 목록을 덮어씀

- 재현: 휴지통 조회 응답을 지연시킨다. 휴지통을 열고 즉시 보관함으로 돌아온 뒤 지연된 응답을 전달한다.
- 기대: 현재 보관함 요청의 결과만 표시한다.
- 실제: 보관함 화면에 휴지통 문서가 정상 문서 카드처럼 표시되고 원래 문서 목록이 사라진다. `renderLibrary()`가 요청 시작 시 탭/모드를 고정하거나 응답 세대를 검증하지 않으며, 렌더링 시점의 전역 탭 상태로 카드 동작을 결정한다.
- 추가 재현: 보관함 응답을 지연한 채 휴지통으로 이동하면, **삭제하지 않은 정상 문서에 복원·영구 삭제 버튼이 표시된다.** 캐시 만료 후 응답 순서를 제어한 Chromium 테스트에서 확인했다. 서버 영구 삭제 API도 소유권만 검사하고 휴지통 상태를 요구하지 않으므로 이 노출은 데이터 손실 위험이다.
- 근거: [backend/routers/library.py:953](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/backend/routers/library.py#L953), [frontend/src/main.js:7747](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L7747), [frontend/src/main.js:7775](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L7775), [frontend/src/main.js:7800](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L7800), [frontend/src/main.js:9257](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L9257).
- 화면 증거: [정상 문서 Alpha/Beta가 휴지통 카드로 표시된 화면](archive-as-trash.png). 화면의 날짜 오류는 생성 시각을 생략한 테스트 픽스처 값이며 별도 제품 결함으로 집계하지 않았다.
- 수정 방향: 렌더 요청 토큰과 탭/모드 스냅샷을 사용해 오래된 응답을 폐기한다. 파괴적 버튼은 문서의 삭제 상태도 검증해야 한다.

### UX-03 · P2 · 노트 화면 재방문 후 즐겨찾기와 더보기 클릭이 무효화

- 재현: 노트 → 라이브러리 → 노트로 이동한 뒤 문서의 즐겨찾기 별을 한 번 누른다.
- 기대: 즐겨찾기가 한 번 전환된다.
- 실제: 같은 클릭이 두 번 처리돼 원래 상태로 돌아온다. 브라우저 재현에서 `easypaper_library_favorites`는 `[]`로 남았다. 방문 횟수에 따라 더보기/접기도 반복 토글될 수 있다.
- 원인: `#page-notes`는 유지되는데 매 진입마다 같은 root에 click/change/keydown 리스너를 추가한다. `innerHTML` 교체는 root 리스너를 제거하지 않는다.
- 근거: [frontend/src/pages/notesPage.js:578](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/pages/notesPage.js#L578), `:605`, `:671`, `:678`, `:744`.
- 수정 방향: root 위임 리스너를 한 번만 등록하거나 이전 등록을 AbortController/명시적 해제로 정리한다.

### UX-04 · P2 · 검색 입력 직후 지우면 필터·보기 전환이 사라짐

- 재현: 검색어 입력 후 300ms 디바운스가 끝나기 전에 지우기 버튼을 누른다.
- 기대: 전체 목록 및 필터가 유지된다.
- 실제: 남아 있는 타이머가 검색 모드를 다시 켜고 필터 행을 숨긴다. 입력은 비어 있어 결과 응답은 버려지지만 필터 행은 복구되지 않는다. 같은 행의 정렬/보기 전환도 영향을 받는다.
- 근거: [frontend/src/main.js:8960](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L8960), `:8978`.
- 수정 방향: 지우기, 목록 재렌더, 검색 종료 시 타이머와 진행 중 요청을 취소/무효화한다.

### UX-05 · P2 · 일괄 삭제 실패를 성공으로 안내

- 재현: 문서를 선택하고 일괄 삭제를 승인하되 DELETE 요청에 HTTP 500을 반환한다.
- 기대: 실패한 문서와 재시도 가능 상태를 보여준다.
- 실제: `1개 논문이 휴지통으로 이동되었습니다.` 성공 토스트를 표시하고 선택을 해제한다. 서버에서 문서는 삭제되지 않는다.
- 원인: `Promise.allSettled()` 결과를 검사하지 않아 rejection이 catch로 전달되지 않는다. 일괄 PDF 캐시 삭제에도 같은 코드 패턴이 있다.
- 근거: [frontend/src/main.js:6266](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L6266), `:6290`.
- 검증 범위: 일괄 문서 삭제는 브라우저에서 HTTP 500으로 재현했고, 캐시 삭제는 동일한 실패 처리 누락을 코드로 확인했다.
- 수정 방향: fulfilled/rejected를 집계해 부분 성공을 표시하고 실패한 항목의 선택을 유지한다.

### UX-06 · P2 · 문서가 없는 라이브러리에서 기존 폴더가 사라짐

- 재현: 라이브러리 문서는 0개, 루트 폴더는 1개 이상인 상태로 진입한다. 신규 사용자가 업로드 전에 폴더를 만드는 경우에도 해당한다.
- 기대: 빈 폴더를 표시해 열기·이름 변경·삭제할 수 있다.
- 실제: 빈 라이브러리 안내만 보이고 폴더 카드가 렌더링되지 않는다. 보기 전환 등 다른 렌더 경로를 거쳐야 나타날 수 있다.
- 원인: 폴더 조회 후에도 `docs.length === 0`에서 반환하여 `filterLibraryCards()`의 폴더 렌더에 도달하지 않는다.
- 근거: [frontend/src/main.js:7816](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L7816), `:8891`.
- 수정 방향: 문서와 현재 폴더의 하위 폴더를 함께 고려해 empty state를 결정한다.

### UX-07 · P2 · 삭제 확인창에 키보드 포커스가 들어가지 않고 Escape가 배경을 조작

- 재현: 문서를 선택하고 삭제 확인창을 연 뒤 Escape를 누른다.
- 기대: 확인창 내부로 포커스가 이동하고, Escape는 취소하며, 포커스가 원래 버튼으로 돌아간다.
- 실제: 확인창이 남아 있다. 라이브러리 전역 Escape 핸들러가 배경 선택을 지운다. 확인창은 `.modal-overlay`용 포커스 트랩의 대상도 아니다.
- 영향: 키보드 사용자가 배경 컨트롤로 이동할 수 있고 확인창 표시 내용과 실제 선택 상태가 어긋난다. Delete 반복 입력으로 확인창이 중첩될 여지도 있다.
- 근거: [frontend/src/main.js:489](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L489), `:7043`, `:7091`, `:11533`.
- 수정 방향: 공통 모달 수명주기에 통합해 초기 포커스·Tab 순환·Escape 취소·복귀를 구현하고 모달 표시 중 배경 단축키를 차단한다. 선택 대상도 확인창을 열 때 고정한다.

### UX-08 · P2 · IME 조합 확정 Enter가 작성 중 채팅을 전송

- 재현: 뷰어 채팅에 작성 중인 문자열을 넣고 `isComposing=true`, `keyCode=229`인 Enter keydown을 전달한다.
- 기대: 입력 조합만 확정하고 명시적인 다음 Enter에서 전송한다.
- 실제: `/api/chat/stream` 요청이 1회 발생한다. `keydown`에서 `isComposing`/229를 검사하지 않는다. 비교 채팅과 독립 채팅 입력에도 같은 조건이 있다.
- 근거: [frontend/src/main.js:16035](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L16035), `:6660`, `:7013`.
- 검증 한계: 브라우저에 조합 이벤트를 주입한 재현이다. 운영체제별 실제 한국어/일본어 IME 키 입력은 별도 확인이 필요하다.
- 수정 방향: composing Enter를 무시하고 각 채팅 입력에 같은 방어 조건을 적용한다.

### UX-09 · P2 · 노트 브리핑이 사용자의 목표 언어를 무시

- 재현: UI와 번역 목표 언어를 영어로 설정하고 노트의 문서 요약을 연다.
- 기대: 선택한 목표 언어로 브리핑을 조회한다.
- 실제: 요청은 `target_lang=한국어`다. 노트만 `fetchPrimer(docId)`를 호출하여 기본값을 사용한다. 캐시도 docId만으로 관리돼 언어별 결과가 구분되지 않는다.
- 근거: [frontend/src/pages/notesPage.js:68](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/pages/notesPage.js#L68), `:433`, [frontend/src/library.js:456](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/library.js#L456). 라이브러리 상세 패널은 [frontend/src/main.js:10205](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/main.js#L10205)에서 목표 언어를 전달한다.
- 수정 방향: 현재 문서/모드의 목표 언어를 전달하고 언어를 캐시 키에 포함한다.

### UX-10 · P2 · 노트 브리핑의 일시 오류가 새로고침 전까지 고정

- 재현: 최초 브리핑 조회에 503을 반환하고 이후 요청은 성공하도록 복구한다. 다른 화면을 거쳐 해당 노트로 돌아온다.
- 기대: 재진입 시 재시도하거나 재시도 버튼을 제공한다.
- 실제: `브리핑을 불러오지 못했습니다.`만 계속 표시된다. `summaryCache`의 error 상태를 ready와 동일하게 영구 재사용하며 다시 요청하지 않는다.
- 근거: [frontend/src/pages/notesPage.js:348](https://github.com/orion-gz/EasyPaper/blob/6d9b2dbb6aec3bb6c17282284306f3c37f8e028d/frontend/src/pages/notesPage.js#L348), `:433`.
- 수정 방향: 오류 캐시에 만료·재시도 정책을 적용하고 명시적 재시도 UI를 제공한다.

## 검증 결과

| 검증 | 결과 | 해석 |
| --- | --- | --- |
| 프론트엔드 빌드 및 i18n 검증 | 통과 | 잠금 파일 기준 의존성 설치 후 실행 |
| 단위 테스트 | 210 통과 | 기존 단위 테스트 전체 |
| 기존 Chromium E2E | 294 통과 / 14 실패 / 4 건너뜀 (312개) | 기본 시간 제한, 4 workers |
| Chromium PDF 성능 분리 실행 | 5 통과 | 1 worker, 테스트 60초 / 기본 assertion 20초로 확대 |
| Chromium 메모·읽기 위치·선택 분리 실행 | 4 통과 / 2 실패 | 메모 3개·가로 읽기 위치 통과; 선택 테스트 시간 초과, 혼합 페이지 검사는 공유 서버 종료로 연결 거부 |
| Chromium 읽기 위치 독립 재검증 | 가로·혼합 크기 2개 모두 통과 | 공유 서버 종료 영향 제거. 같은 실행의 검색 지우기 결함은 재현됨 |
| 기존 WebKit 핵심 흐름 E2E | 7 통과 / 32 실패 (39개) | 요소 대기·시간 초과 등과 공유 서버 종료 후 연결 거부 3건이 섞인 실행 |
| WebKit 뷰어 핵심 접근성 분리 실행 | 1 통과 | 테스트 60초 / 기본 assertion 20초로 확대 |
| 신규 결함 재현 | Chromium 10개 시나리오에서 기대 동작 불일치 확인 | UX-02의 양방향 경합을 각각 검증한 10개 테스트. UX-01은 별도 서버 격리 재현 |
| WebKit 신규 결함 교차 확인 | 9개 시나리오에서 같은 불일치 확인 | 최초 9개 중 IME는 로딩 시간 초과여서 분리 재실행 후 전송 요청 1회 확인 |

**기존 브라우저 테스트 전체가 통과한 상태는 아니다.** 대기 시간을 늘린 재검증의 통과를 최초 실패를 없앤 것으로 집계하지 않았다. PDF 선택의 반복 시간 초과, 뷰어 새로고침·탭 복원 관련 최초 실패, WebKit 광범위 실패는 원인이 완전히 확정되지 않아 위 10건의 확정 결함에 추가하지 않았다. 출시 후보에서 독립 서버·적절한 실행 자원으로 재검증하고 macOS WKWebView에서도 확인해야 한다.

실행상의 한계도 있었다. 여러 브라우저 실행이 같은 정적 서버를 재사용한 결과, 소유한 Chromium 실행이 끝나면서 후속 실행 일부가 연결 거부로 실패했다. 이 실패는 제품 결함이 아니다. 조사 재개 시 다른 실행 없이 읽기 위치 검증을 다시 실행했다.

최초 Chromium 실패 목록 및 후속 검사 결과는 [validation.txt](validation.txt)에 보존했다.

## 재현 자료 실행

`reproduction.spec.js`는 **정상 동작을 기대하는 회귀 검증**으로, 조사 기준 커밋에서 결함을 드러내기 위해 실패한다. 기존 E2E 검색 경로 밖에 보관하여 기본 CI에 실패 테스트를 추가하지 않았다.

별도 Worktree 루트에서:

```bash
npm --prefix frontend ci
npm --prefix frontend run build
cp docs/audits/v1.3.0/reproduction.spec.js frontend/tests/e2e/ui-ux-audit.spec.js
cd frontend
npx playwright test ui-ux-audit.spec.js --workers=1 --reporter=list
# WebKit 교차 확인
npx playwright test ui-ux-audit.spec.js --config playwright.webkit.config.js --workers=1 --reporter=list
# 조사 완료 후 임시 테스트 제거
rm tests/e2e/ui-ux-audit.spec.js
```

서버 삭제 범위의 안전한 격리 재현(저장소 루트에서):

```bash
python3 docs/audits/v1.3.0/trash-scope-repro.py
```

이 스크립트는 실제 라우터 함수 본문을 추출하지만 문서 조회·삭제·worker 정지를 가짜 구현으로 대체한다. API 서버나 실제 DB에 연결하지 않는다.

## 조사 한계

- API 응답을 모킹한 UI 테스트이며, 실제 LLM·외부 제공자·실제 사용자 DB와의 통합 검증은 아니다.
- Linux Playwright WebKit은 macOS Tauri WKWebView 실기기 검증을 대체하지 않는다.
- 운영체제 파일 선택창, 네이티브 창, 설치·업데이트·실제 IME 동작은 출시 후보 바이너리에서 추가 확인이 필요하다.
- 발견 개수는 조사한 범위에서 확인된 결함 수이며, 나머지 경로에 결함이 없다는 의미는 아니다.
