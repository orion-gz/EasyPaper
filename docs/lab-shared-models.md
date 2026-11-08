# Lab 공유 모델 관리

공유 추론 서버를 먼저 저장한 뒤 Lab Master가 추천 모델 또는 직접 입력한 ID로 다운로드를 시작한다. 기존 `models`/`model` 설정과 API는 유지하며, 기존 허용 모델을 설치 미검증 상태의 목록 항목으로 이전한다. 기존 접근 권한을 잃지 않도록 이 항목은 활성 상태를 유지한다. `재시도 / 검증`으로 실제 설치 여부를 확인할 수 있다.

## 추천 목록과 근거

공식 자료 확인일: **2026-11-08**. 아래 모델은 총 파라미터 3B–40B 범위의 로컬 실행 가능한 오픈 웨이트 모델이다. Qwen/Gemma의 다국어·문서 이해 모델을 중심으로 구성하고 gpt-oss를 추론 용도로 포함한다. 한국어 번역 품질의 자체 벤치마크 순위를 의미하지 않는다. 실제 논문과 언어 조합으로 평가한 후 선택해야 한다.

| 모델 | Ollama ID | Hugging Face / vLLM ID | 예상 VRAM (Ollama / HF) |
|---|---|---|---|
| Qwen 3.8 27B | `qwen3.8:27b` | `Qwen/Qwen3.8-27B` | 24 / 64 GB |
| Qwen 3.5 4B | `qwen3.5:4b` | `Qwen/Qwen3.5-4B` | 6 / 12 GB |
| Qwen 3.5 9B | `qwen3.5:9b` | `Qwen/Qwen3.5-9B` | 10 / 24 GB |
| Gemma 4 26B A4B | `gemma4:26b` | `google/gemma-4-26B-A4B-it` | 24 / 64 GB |
| Gemma 4 31B | `gemma4:31b` | `google/gemma-4-31B-it` | 28 / 72 GB |
| gpt-oss 20B | `gpt-oss:20b` | `openai/gpt-oss-20b` | 16 / 16 GB |

VRAM 값은 짧은 컨텍스트를 전제로 한 계획용 추정치다. 최대 컨텍스트, 동시 사용자, KV 캐시, 런타임 및 GPU에 따라 증가한다. Ollama는 해당 라이브러리 태그의 기본 양자화를 사용하고 다운로드 후 실제 양자화를 표시한다. HF는 원본 BF16, gpt-oss는 MXFP4이다. 추정치가 GPU 지원이나 OOM 부재를 보장하지 않는다.

- [Qwen 3.8 Ollama 공식 태그](https://ollama.com/library/qwen3.8:27b), [Qwen 공식 모델 카드](https://huggingface.co/Qwen/Qwen3.8-27B): 최신 세대의 연구·문서 이해 용도.
- [Qwen 3.5 Ollama](https://ollama.com/library/qwen3.5), [4B](https://huggingface.co/Qwen/Qwen3.5-4B), [9B](https://huggingface.co/Qwen/Qwen3.5-9B): 작은 GPU에서 대화·번역·문서 분석을 위한 선택지.
- [Gemma 4 Ollama](https://ollama.com/library/gemma4), [26B A4B](https://huggingface.co/google/gemma-4-26B-A4B-it), [31B](https://huggingface.co/google/gemma-4-31B-it): Google의 다국어·문서 이해 모델. MoE 크기는 활성 파라미터가 아닌 전체 크기를 기준으로 포함한다.
- [gpt-oss Ollama](https://ollama.com/library/gpt-oss), [공식 20B 카드](https://huggingface.co/openai/gpt-oss-20b): 추론 중심 대안. 한국어 성능 우위를 주장하지 않는다.
- [vLLM 지원 모델](https://docs.vllm.ai/en/latest/models/supported_models/): 문서만 보고 설치 환경 지원을 가정하지 않는다. 설정된 실제 vLLM Python의 `ModelRegistry.get_supported_archs()` 결과로 추천 목록을 필터링한다.

목록 메타데이터와 출처는 `backend/services/shared_model_catalog.py`에 있다. 자동으로 미확인 모델을 추가하지 않는다. 업데이트 시 공식 ID, 전체 파라미터, 런타임 아키텍처 및 양자화를 다시 확인한다.

## 다운로드와 상태

- SQLite `shared_models`에 서버별 모델 ID, 진행 상태, 바이트 수, 속도, 오류, 활성 여부, 검증 결과와 HF revision을 저장한다. 서버·모델 ID 중복은 하나의 항목으로 처리한다.
- API 프로세스가 작업을 소유한다. 브라우저는 2초 간격으로 관찰하므로 탭 이동이나 연결 종료로 다운로드가 중단되지 않는다. 한 API 프로세스에서 최대 2개를 병렬 다운로드하며 나머지는 Pending 상태다.
- `Pending → Downloading → Verifying → Completed` 또는 `Failed`/`Cancelled`로 전이한다. 완료·검증 후에만 새 모델을 활성 허용 목록에 넣는다.
- Ollama는 기존 HTTPS/SSH 연결과 API 인증을 재사용한다. `/api/tags`로 중복 설치 확인, `/api/pull` 스트림으로 다운로드, `/api/show` 및 `/api/tags`로 설치와 completion 지원을 확인한다. 진행률은 **이미 발견된 레이어 합계** 기준이므로 새 레이어가 발견되면 변할 수 있다. 추론 요청은 보내지 않는다.
- HF 워커는 별도 프로세스로 실행한다. 모델 메타데이터의 commit SHA를 고정하고 표준 Hub 캐시에 파일을 저장한다. 실제 설치된 vLLM 아키텍처 지원, safetensors 및 tokenizer 존재를 확인한 후 다운로드한다. 완료 시 파일 크기, safetensors 헤더, 로컬 tokenizer 로딩, 인덱스의 모든 weight shard 존재를 검증한다. `trust_remote_code`를 켜지 않는다.
- 취소는 Ollama 스트림을 닫거나 HF 워커를 종료한다. 엔진이 이미 받은 레이어 또는 Hub partial 캐시는 유지한다. Ollama 내부의 다른 pull 소비자까지 중단하는 것은 보장하지 않는다. 재시도는 캐시를 재사용한다.
- API 재시작으로 중단된 작업은 오류/취소 상태로 남으며 사용자가 재시도할 수 있다. 프로세스 종료 후 무조건 자동 재다운로드하지 않는다.
- 다운로드 완료와 서빙 가능 여부를 구분한다. Ollama는 설치 목록, vLLM은 `/models` 결과를 표시한다. GPU 메모리/실행 중 요청량을 이 상태에서 추측하지 않는다. 기존 리소스·추론 정책을 바꾸지 않는다.

## vLLM 배포 설정

vLLM의 OpenAI 호환 HTTP API에는 일반적인 모델 다운로드·다중 모델 로딩 API가 없다. Lab API가 vLLM과 공유하는 캐시와 **실제 서빙 환경의 Python**을 지정해야 한다. 임의의 원격 vLLM URL만 설정한 경우에는 다운로드를 허용하지 않고 배포 안내를 표시한다.

Lab 서버 환경 변수 예시:

```sh
EASYPAPER_VLLM_TARGETS='{"SERVER_ID":{"python":"/opt/vllm/bin/python","cache":"/srv/huggingface/hub"}}'
```

`SERVER_ID`는 `/api/inference/servers`의 서버 ID다. Python과 캐시 경로는 Lab API 프로세스에서 접근 가능한 절대 경로여야 한다. 해당 Python 환경에는 실제 서빙과 같은 vLLM, Transformers, safetensors 및 `hf_hub_download(tqdm_class=...)`를 지원하는 huggingface_hub가 필요하다. HF 워커는 GPU 모델을 생성하지 않는다. 다운로드 진행률을 위해 워커에서 Xet 가속을 끄고 Hub의 HTTP 전송을 사용한다.

vLLM에도 같은 저장소를 `HF_HUB_CACHE=/srv/huggingface/hub` 또는 `--download-dir /srv/huggingface/hub`로 연결한다. 컨테이너를 사용하는 경우 양쪽 컨테이너에 같은 호스트 캐시를 마운트하고 실제 서빙 환경과 일치하는 Python 환경을 Lab API에서 사용할 수 있도록 구성한다. 모델 로딩/서빙 전환은 기존 운영 정책으로 수행한다. 확인된 revision은 상태 API에서 확인 가능하며 서빙 시 같은 revision을 지정할 수 있다.

인증이 필요한 저장소는 Lab 서버의 `HF_TOKEN` 또는 Hub 자격 증명을 사용한다. 라이선스 수락/토큰 권한이 없으면 안내 오류를 표시한다. 토큰은 모델 상태나 UI 응답에 저장하지 않는다.

## 권한, 동기화 및 삭제

모델 관리·추천·작업 API는 기존 `require_admin_user`로 보호한다. Member는 공개 서버 목록의 활성 모델만 선택할 수 있다. 개인 모델 선택지는 5초 간격으로 갱신되며 비활성화한 모델은 기존 서버 선택 정책에서도 차단된다. 설정 저장이 오래된 클라이언트의 허용 목록으로 비활성 모델을 다시 활성화하지 않도록 보호한다.

`공유 해제 (파일 유지)`는 접근 허용 목록과 관리 항목만 제거한다. 실제 파일 삭제는 원격 엔진 외부의 다른 사용자와 진행 중인 추론을 확인할 수 없어 API에서 거부한다. 모델 파일 정리는 모든 소비자를 중단한 유지보수 시간에 해당 호스트에서 수행한다. HF 공유 blob 파일을 직접 삭제하지 않는다. 다운로드 중 서버 변경·삭제는 차단한다.

## 검증 및 한계

CPU 테스트는 Ollama 스트림, 오류/중단, 기존 설치 건너뛰기, 취소/재시도, 재시작 상태 복구, 이전 설정 유지, 오래된 설정 저장, Member 접근 거부, HF 파일/인덱스 검증과 워커 프로세스 종료를 검증한다. 브라우저 테스트는 추천/직접 입력, 화면 재진입, 진행률, 오류 문구의 안전한 출력, 재시도/취소, 활성화 변경과 Member 선택지 갱신을 검증한다.

실제 Ollama/vLLM GPU 서버와 수십 GB 모델 다운로드는 이 개발 환경에서 실행하지 않았다. 운영 환경에서 캐시 마운트, 토큰, 디스크 여유, 실제 vLLM 버전·양자화·GPU 조합을 검증해야 한다. 아키텍처 지원과 파일 검증은 실제 추론 성공을 보장하지 않는다. 기존 `연결 확인`의 추론 검증을 사용한다.

현재 기존 Lab 실행 구조와 동일하게 **하나의 API worker**에서 운영한다. 다중 API worker/다중 노드 작업 소유권과 자동 failover는 지원하지 않는다. 직접 입력은 Ollama의 기본 레지스트리 `name:tag`/`namespace/name:tag`와 HF `owner/model` 네이티브 safetensors 저장소를 지원하며, 사용자 지정 registry URL, GGUF-only HF 저장소, 임의 원격 Python 실행은 지원하지 않는다.
