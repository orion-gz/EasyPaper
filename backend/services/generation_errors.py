"""Safe, structured generation failures shared by streams and background tasks."""


class GenerationError(RuntimeError):
    def __init__(self, code: str, message: str, **params):
        super().__init__(message)
        self.document_task_error_code = code
        self.error_params = params


def generation_error_payload(exc: Exception) -> dict:
    from services.document_tasks import classify_error

    code, _ = classify_error(exc)
    return {
        "code": code,
        "params": getattr(exc, "error_params", {}),
        "fallback": "Translation failed. Check the error code and server logs.",
    }
