fn main() {
  // lib.rs의 kill_backend_sidecar처럼 앱이 직접 정의한 커맨드는 tauri_build::build()의
  // 기본 설정만으로는 ACL 권한이 전혀 생성되지 않아, capabilities에 아무리 추가해도
  // "not allowed by ACL"로 항상 막힌다(실제로 이 문제로 업데이트 설치 시 sidecar 종료
  // 요청이 조용히 실패해 파일 잠금 버그가 재발했다). AppManifest::commands로 이
  // 커맨드에 대한 allow-kill-backend-sidecar/deny-kill-backend-sidecar 권한이
  // 자동 생성되도록 명시해야 capabilities/default.json에서 참조할 수 있다.
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(tauri_build::AppManifest::new().commands(&[
        "kill_backend_sidecar",
        "backend_startup_error",
      ])),
  )
  .expect("failed to run tauri-build");
}
