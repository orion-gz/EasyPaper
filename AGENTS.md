# 프로젝트 워크플로우 및 코딩 규칙

## 1. Git Workflow
### Branch Rules
* `main`에는 직접 커밋하지 않는다.
* 모든 작업은 새로운 브랜치에서 진행한다.
* 브랜치 이름은 다음 규칙을 따른다.
  * `feature/<name>` : 새로운 기능
  * `fix/<name>` : 버그 수정
  * `refactor/<name>` : 리팩토링
  * `docs/<name>` : 문서 수정
* **하나의 브랜치는 하나의 목적만 가진다.**
* 브랜치에서는 해당 작업과 직접 관련된 변경만 수행한다.
* 기능 추가, 버그 수정, 리팩토링, 기능 삭제 등 목적이 다른 작업은 같은 브랜치에서 함께 진행하지 않는다.
* 새로운 작업이 필요하면 새로운 브랜치를 생성한다.

### Commit Rules
- Conventional Commits를 사용한다.

예시
```text
feat: add login page
fix: resolve token issue
refactor: simplify pipeline
docs: update README
```

### Pull Request
* 하나의 PR에는 하나의 작업만 포함한다.
* 작업 완료 후 PR을 생성한다.
* 병합 후 작업 브랜치는 삭제한다.

### Agent Rules
* 현재 브랜치를 확인한 후 작업한다.
* 관련 없는 파일은 수정하지 않는다.
* 기존 코드 스타일을 유지한다.
* Merge Conflict가 발생하면 사용자에게 확인을 요청한다.

### PR 요약 작성 규칙 (PR Summary Template)
PR 작성 요청시  반드시 아래 템플릿 포맷에 맞춰서 마크다운으로 작성한다. 어체는 '~수정함', '~ 기능을 추가' 등 간결한 명사 종결 어체를 사용할 것. 

#### [PR 요약 템플릿]

```
# Summary 
## 1. 기능/버그 수정사항 1
- (변경된 주요 로직, 파일, 함수 등 불릿 포인트로 상세히 나열)
## 2. 기능/버그 수정사항 2
- (변경된 주요 로직, 파일, 함수 등 불릿 포인트로 상세히 나열)
...
```