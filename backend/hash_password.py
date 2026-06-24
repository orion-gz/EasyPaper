import hashlib
import os
import getpass

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
    return f"{salt.hex()}:{key.hex()}"

if __name__ == "__main__":
    print("==================================================")
    print(" EasyPaper — Secure Password Hash Generator")
    print("==================================================")
    password = getpass.getpass("Enter password to hash: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Error: Passwords do not match!")
        exit(1)
    
    hashed = hash_password(password)
    print("\nGeneration Successful!")
    print("--------------------------------------------------")
    print(f"APP_PASSWORD_HASH={hashed}")
    print("--------------------------------------------------")
    print("Copy and paste the line above into your backend/.env file.")
    print("==================================================")
