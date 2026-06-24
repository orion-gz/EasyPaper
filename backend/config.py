import os
from dotenv import load_dotenv

load_dotenv()

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
TRANS_PROVIDER = os.getenv("TRANS_PROVIDER", "ollama")
TRANS_MODEL = os.getenv("TRANS_MODEL", "gemma4:e4b")
CHAT_PROVIDER = os.getenv("CHAT_PROVIDER", "ollama")
CHAT_MODEL = os.getenv("CHAT_MODEL", "gemma4:e4b")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY", "")

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "24"))
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
CACHE_DIR = os.getenv("CACHE_DIR", "./cache")
LIBRARY_DIR = os.getenv("LIBRARY_DIR", "./library")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

def get_ollama_host() -> str:
    return OLLAMA_HOST

def get_trans_provider() -> str:
    return TRANS_PROVIDER

def get_trans_model() -> str:
    return TRANS_MODEL

def get_chat_provider() -> str:
    return CHAT_PROVIDER

def get_chat_model() -> str:
    return CHAT_MODEL

def get_openai_api_key() -> str:
    return OPENAI_API_KEY

def get_gemini_api_key() -> str:
    return GEMINI_API_KEY

def get_claude_api_key() -> str:
    return CLAUDE_API_KEY

def update_system_settings(
    ollama_host: str,
    trans_provider: str,
    trans_model: str,
    chat_provider: str,
    chat_model: str,
    openai_api_key: str = "",
    gemini_api_key: str = "",
    claude_api_key: str = ""
):
    global OLLAMA_HOST, TRANS_PROVIDER, TRANS_MODEL, CHAT_PROVIDER, CHAT_MODEL, OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_API_KEY
    
    OLLAMA_HOST = ollama_host
    TRANS_PROVIDER = trans_provider
    TRANS_MODEL = trans_model
    CHAT_PROVIDER = chat_provider
    CHAT_MODEL = chat_model
    OPENAI_API_KEY = openai_api_key
    GEMINI_API_KEY = gemini_api_key
    CLAUDE_API_KEY = claude_api_key
    
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    settings = {
        "OLLAMA_HOST": ollama_host,
        "TRANS_PROVIDER": trans_provider,
        "TRANS_MODEL": trans_model,
        "CHAT_PROVIDER": chat_provider,
        "CHAT_MODEL": chat_model,
        "OPENAI_API_KEY": openai_api_key,
        "GEMINI_API_KEY": gemini_api_key,
        "CLAUDE_API_KEY": claude_api_key
    }

    if not os.path.exists(env_path):
        with open(env_path, "w", encoding="utf-8") as f:
            for k, v in settings.items():
                f.write(f"{k}={v}\n")
        return
        
    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    new_lines = []
    found_keys = set()
    
    for line in lines:
        stripped = line.strip()
        updated = False
        for k in settings.keys():
            if stripped.startswith(f"{k}="):
                new_lines.append(f"{k}={settings[k]}\n")
                found_keys.add(k)
                updated = True
                break
        if not updated:
            new_lines.append(line)
            
    for k, v in settings.items():
        if k not in found_keys:
            new_lines.append(f"{k}={v}\n")
            
    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)


# Authentication settings
APP_USERNAME = os.getenv("APP_USERNAME", "admin")
DEFAULT_PASSWORD_HASH = "0102030405060708090a0b0c0d0e0f10:c8c17b1c61732cde577461e36b682deab2dda5cd72797d2517526dfcbc39d6b3"
APP_PASSWORD_HASH = os.getenv("APP_PASSWORD_HASH", DEFAULT_PASSWORD_HASH)
APP_PASSWORD = os.getenv("APP_PASSWORD", "")
SECRET_KEY = os.getenv("SECRET_KEY", "easypaper_secret_key_change_me_in_production_1234567890")

def get_app_username() -> str:
    return APP_USERNAME

def get_app_password_hash() -> str:
    return APP_PASSWORD_HASH

def get_app_password() -> str:
    return APP_PASSWORD

def update_credentials_in_env(new_username: str, new_password_hash: str):
    global APP_USERNAME, APP_PASSWORD_HASH, APP_PASSWORD
    
    APP_USERNAME = new_username
    APP_PASSWORD_HASH = new_password_hash
    APP_PASSWORD = ""  # Clear plaintext password for security
    
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(f"APP_USERNAME={new_username}\nAPP_PASSWORD_HASH={new_password_hash}\n")
        return
        
    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    new_lines = []
    username_found = False
    hash_found = False
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("APP_USERNAME="):
            new_lines.append(f"APP_USERNAME={new_username}\n")
            username_found = True
        elif stripped.startswith("APP_PASSWORD_HASH="):
            new_lines.append(f"APP_PASSWORD_HASH={new_password_hash}\n")
            hash_found = True
        elif stripped.startswith("APP_PASSWORD="):
            # Deactivate plaintext password by commenting it out
            new_lines.append(f"# APP_PASSWORD=\n")
        else:
            new_lines.append(line)
            
    if not username_found:
        new_lines.append(f"APP_USERNAME={new_username}\n")
    if not hash_found:
        new_lines.append(f"APP_PASSWORD_HASH={new_password_hash}\n")
        
    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

# 디렉토리 생성
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(LIBRARY_DIR, exist_ok=True)

