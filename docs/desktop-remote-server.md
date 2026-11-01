# 데스크톱 원격 서버 연결

데스크톱 앱의 첫 연결 화면에서 **이 컴퓨터에서 사용** 또는 **원격 서버에 연결**을 선택한다. 기존 설치를 업데이트한 경우에도 한 번 표시된다. 원격 연결에는 브라우저에서 사용하는 EasyPaper 주소(예: `https://paper.example.com`)를 입력하고, 연결 후 서버 계정으로 로그인한다. 하위 경로 배포 주소도 사용할 수 있다.

**설정 → Data → 서버 연결**, 또는 화면 오른쪽 아래 **연결: 로컬 / 원격 서버** 버튼에서 연결을 켜고 끌 수 있다. 서버에 접속할 수 없거나 로그인하지 못한 상태에서도 연결 설정을 열고 로컬 모드로 돌아갈 수 있다. 연결 상태는 앱을 다시 실행해도 유지된다.

로컬 라이브러리·계정·AI 설정은 그대로 보관한다. 원격 모드의 문서 조회·편집·삭제·업로드는 연결된 서버에 적용되며, 로컬 모드로 돌아오면 기존 로컬 데이터를 사용한다. 서버별 브라우저 저장 공간과 로그인 세션도 분리된다. 앱 화면과 데스크톱 업데이트는 설치된 앱에서 제공하므로 서버와 앱은 호환되는 EasyPaper API 버전을 사용해야 한다.

## 서버 데이터 다운로드

1. 원격 모드에서 서버 계정으로 로그인한다.
2. **서버 연결 → 서버 데이터를 이 컴퓨터로 다운로드**를 누른다.
3. 다운로드 및 로컬 가져오기가 끝날 때까지 앱을 열어 둔다.
4. **이 컴퓨터에서 사용 → 저장하고 열기**를 선택하면 가져온 문서를 로컬에서 사용할 수 있다.

다운로드는 해당 서버 계정의 저장된 데이터 스냅샷이다. 문서 원본, 번역, 채팅, 주석·메모, 폴더, 읽기 기록 등 기존 사용자 백업 형식에 포함되는 데이터를 가져온다. 원격 서버의 계정·비밀번호·API 키·시스템 설정 및 브라우저에만 저장된 미동기화 정보는 복사하지 않는다. 로컬 사용자 환경설정도 바꾸지 않는다.

기존 문서를 덮어쓰지 않도록 새 ID로 추가한다. **반복 다운로드는 복사본을 추가하며, 자동 동기화나 중복 제거가 아니다.** 원격 서버에는 사용자 데이터 내보내기 API가 있어야 한다. 백업은 기존 형식과 동일하게 압축 파일 4 GiB, 압축 해제 8 GiB 한도를 적용한다. 검증 또는 가져오기 실패 시 기존 로컬 데이터는 유지된다. 가져온 문서의 새 AI 작업에는 로컬 AI 설정이 필요하다.

## 구현 및 검증

- `EASYPAPER_DESKTOP=1`인 로컬 sidecar만 `/desktop/connection`, `/desktop/download`를 등록한다. 웹·Docker 배포에는 등록하지 않는다.
- `desktop-connection.json`은 앱 설정 디렉터리에 서버 주소, 연결 여부, 온보딩 완료 여부 및 서버별 loopback 포트를 저장한다. 비밀번호나 세션 토큰은 저장하지 않는다.
- 서버마다 고정된 별도 loopback origin에서 로컬 UI를 제공하고 `/api/**` 요청만 해당 서버로 중계한다. 업로드, PDF Range 및 SSE 응답은 스트리밍한다. 서버 응답 실패 시 로컬 API로 대체하지 않는다.
- 쿠키는 포트별로 분리되지 않으므로 원격 세션 쿠키 이름에 서버 식별자를 붙인다. 서버로는 해당 서버의 세션만 전달하며 로컬 로그인 쿠키를 보내지 않는다.
- 저장된 원격 포트를 다른 프로그램이 점유하면 오류를 표시한다. 다른 포트의 브라우저 데이터를 잘못 사용하는 대신 점유한 프로그램을 종료하고 다시 연결해야 한다.
- 기존 사용자 백업 가져오기를 사용하되 사용자 환경설정 보존 옵션을 적용한다. 다운로드 중 중복 요청과 연결 변경을 차단한다.

검증 명령:

```sh
python -m pytest backend/tests/test_desktop_connection.py backend/tests/test_user_data_transfer.py backend/tests/test_startup_recovery.py backend/tests/test_content_security_policy.py -q
cd frontend
npm ci
npm run build
npm run test:unit
npx playwright test tests/e2e/desktop-connection.spec.js tests/e2e/desktop-window.spec.js tests/e2e/auth-and-library.spec.js tests/e2e/data-transfer.spec.js
npx playwright test --config playwright.webkit.config.js tests/e2e/desktop-connection.spec.js
```
