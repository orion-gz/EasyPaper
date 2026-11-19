# 랩 모드 설치 및 연결 가이드

랩 모드는 공용 EasyPaper 서버에서 계정, 문서, AI 추론 서비스를 제공합니다. 브라우저와 데스크톱 앱에서 같은 서버 계정으로 접속하면 같은 라이브러리를 사용할 수 있습니다. 서버의 GPU를 사용하기 위해 데스크톱 라이브러리를 다운로드하거나 동기화할 필요는 없습니다.

[English documentation](lab-mode.md) · [데스크톱 원격 서버 연결](desktop-remote-server.md) · [SSH 및 추론 서버 연결](ssh-connections.ko.md)

## 1. EasyPaper 서버 설치

설치 스크립트는 systemd로 부팅한 Ubuntu 24.04 서버를 대상으로 합니다. 인터넷 연결과 sudo 권한이 필요합니다. 서버에 EasyPaper 저장소를 내려받고 프로젝트 폴더에서 다음 중 하나를 실행합니다. 두 배포 방식 모두 기본 포트 8000을 사용합니다.

| 배포 방식 | 설치 명령 | 기본 데이터 경로 |
| --- | --- | --- |
| Docker | `sudo bash deploy/lab/install-docker.sh` | 프로젝트의 `lab-data` |
| systemd | `sudo bash deploy/lab/install-systemd.sh` | `/var/lib/easypaper` |

Docker가 이미 설치되어 있다면 Compose v2와 접근 가능한 Docker 데몬이 필요합니다. 데이터 경로나 실행 UID/GID를 바꾸려면 프로젝트의 `.env`에 `LAB_DATA_DIR`, `LAB_APP_UID`, `LAB_APP_GID`를 설정합니다. 기본 UID/GID는 `1000:1000`이며, 선택한 계정이 기존 데이터에 쓸 수 있어야 합니다.

systemd 설치는 `/opt/easypaper`에 앱을 빌드하고 `easypaper-lab.service`를 등록합니다. 설치가 중단되면 표시된 오류를 해결한 뒤 같은 명령을 다시 실행합니다. 이미 설치된 시스템을 업데이트할 때는 아래의 업데이트 스크립트를 사용합니다.

앱의 **설정 → 랩 모드**에도 설치 가이드와 연결 가이드가 제공됩니다. 설치 가이드의 모든 단계를 확인하면 연결 가이드가 열립니다.

## 2. 관리자 접속 및 비밀번호 변경

초기 설정에는 개인 PC에서 SSH 터널을 엽니다. 예시의 사용자와 호스트를 실제 SSH 계정과 서버 주소로 바꿉니다.

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 user@lab.example.com
```

터미널을 열어 둔 상태에서 브라우저로 `http://localhost:18000`에 접속합니다. 신규 설치에 초기 계정 `admin / admin`을 사용했다면 **설정 → 계정**에서 비밀번호를 변경한 뒤 외부 접속을 설정합니다. 기존 설치에서는 기존 관리자 계정으로 로그인합니다.

## 3. 공용 추론 설정

EasyPaper 서버의 프로젝트 폴더에서 Ollama 설치와 모델 다운로드를 실행합니다. systemd 배포에서는 `--deployment systemd`를 사용합니다.

```sh
sudo bash deploy/lab/install-inference.sh --deployment docker --model qwen3:4b
```

이 스크립트는 필요한 경우 Ollama를 설치하고 모델을 내려받은 뒤 앱의 네트워크 환경에서 한 토큰을 생성해 연결을 확인합니다. GPU 드라이버는 별도로 준비하고 실제 GPU 가속을 확인합니다. Ollama의 11434 포트는 외부에 공개하지 않습니다.

**설정 → 랩 모드**에서 엔진을 Ollama로 선택하고 아래 주소를 입력합니다. 허용 모델과 기본 모델에는 위에서 다운로드한 모델을 지정한 뒤 저장하고 연결을 테스트합니다.

| 배포 방식 | Ollama 주소 |
| --- | --- |
| Docker | `http://host.docker.internal:11434` |
| systemd | `http://127.0.0.1:11434` |

별도 vLLM 서버를 사용하려면 서비스 URL 끝에 `/v1`을 붙입니다. EasyPaper는 추론 전에 vLLM의 서버 루트 `/openapi.json`에서 채팅 요청 스키마가 `cache_salt`를 지원하는지 확인합니다. 여러 서버를 등록하거나 SSH로 추론 서버에 접속하는 절차는 [SSH 및 추론 서버 연결](ssh-connections.ko.md)을 참고합니다.

## 4. 랩 모드 활성화 및 구성원 초대

1. **설정 → 랩 모드**에서 현재 관리자 비밀번호로 랩 모드를 활성화합니다. 활성화되면 로그인 건너뛰기가 꺼집니다.
2. 구성원 계정을 생성하고 화면에 한 번 표시되는 임시 비밀번호를 각 구성원에게 전달합니다.
3. 구성원은 첫 로그인에서 비밀번호를 바꾸고 랩 모드 설정에서 허용된 서버와 모델을 선택합니다. 개인 CLI를 사용할 수 있도록 관리자가 구성한 경우 해당 CLI를 선택할 수 있습니다.

기존 관리자는 마스터 계정이 됩니다. 랩 모드가 켜져 있는 동안에는 사용자 이름을 바꿀 수 없습니다. 구성원을 비활성화하면 해당 계정의 세션이 해제되고 추적 중인 추론 작업이 취소됩니다. 랩 모드를 끄면 보관된 데이터는 유지되고 마스터만 로그인할 수 있습니다.

개인 CLI를 제공하려면 서버에 별도 러너와 격리된 런타임을 구성합니다. 앱은 전용 유닉스 소켓 `EASYPAPER_LAB_RUNNER_SOCKET`으로 러너에 접속하며, 구성원마다 별도 홈 디렉터리를 사용합니다. Docker 및 systemd 구성, 버전이 고정된 런타임 빌드, 운영 서버 검증 절차는 [개인 CLI 격리](lab-mode.md#personal-cli-isolation)를 참고합니다.

## 5. 구성원 연결

### SSH 터널

각 구성원의 PC에서 2단계의 SSH 명령을 실행하고 터미널을 열어 둡니다. SSH 서버에서 포트 포워딩을 허용해야 합니다. 로컬 포트 18000을 바꿨다면 아래 주소에도 같은 포트를 사용합니다.

- 브라우저에서 `http://localhost:18000`을 엽니다.
- 데스크톱 앱에서 **설정 → 데이터 → 서버 연결**을 열고 HTTP(S) 주소로 `http://localhost:18000`을 입력합니다. 앱의 SSH 연결 기능을 사용하면 SSH 호스트와 서버에서 접근할 서비스 URL을 직접 설정할 수도 있습니다.

EasyPaper 로그인에는 발급받은 EasyPaper 계정을 사용합니다. 앱 안의 설치·연결 가이드에서 Linux/macOS 또는 Windows용 SSH 실행 파일을 내려받을 수도 있습니다.

### HTTPS

공개 HTTPS로 접속하기 전에 SSH 터널에서 초기 관리자 비밀번호를 변경합니다. 도메인의 DNS를 서버 공인 IP로 지정하고, 라우터와 방화벽에서 TCP 80 및 443 포트를 허용합니다. 서버의 프로젝트 폴더에서 도메인과 공인 IP를 실제 값으로 바꿔 실행합니다.

```sh
sudo bash deploy/lab/install-https.sh --domain lab.example.com --public-ip 203.0.113.10
```

스크립트는 도메인의 모든 A/AAAA 레코드가 지정한 주소와 일치하는지 검사합니다. 주소가 여러 개라면 `--public-ip`를 반복해서 지정합니다. Caddy 구성을 검증하고 HTTPS 경로를 확인하므로 서버에서도 해당 공인 HTTPS 주소에 접속할 수 있어야 합니다.

구성원은 브라우저나 데스크톱 앱에 `https://lab.example.com`을 입력하고 서버 계정으로 로그인합니다. 서버 라이브러리를 직접 사용하거나, 필요한 경우 [다운로드·동기화·오프라인 작업](desktop-remote-server.md)을 설정합니다.

## 진단, 업데이트 및 복구

서버의 원래 Git 체크아웃에서 실행합니다. 배포 방식과 모델 이름은 실제 환경에 맞게 바꿉니다.

```sh
sudo bash deploy/lab/diagnose.sh --deployment docker --model qwen3:4b
sudo bash deploy/lab/update.sh --deployment docker
sudo bash deploy/lab/rollback.sh --deployment docker --snapshot 20261107T120000Z-0123abcd
```

진단은 앱 API, 실행 상태, 데이터 쓰기 권한, 포트 바인딩을 검사합니다. 업데이트는 기본적으로 `origin/main`을 사용하며, 새 버전을 시작하기 전에 앱 데이터를 백업합니다. 수동 롤백에는 업데이트에서 출력한 스냅샷 ID를 사용합니다. 롤백은 앱과 업데이트 이전 데이터를 함께 복원하며 이후에 생성한 데이터는 별도 디렉터리에 보관됩니다. 외부 추론 모델 저장소, HTTPS 설정, 개인 CLI 홈은 앱 스냅샷에 포함되지 않으므로 따로 백업합니다. [업데이트 및 복구 세부 절차](lab-mode.md#updates-and-recovery)
