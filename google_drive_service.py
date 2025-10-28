# google_drive_service.py
from __future__ import annotations
import os
from datetime import datetime
from typing import Optional

from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request


SCOPES = ['https://www.googleapis.com/auth/drive.file']

# Cache service trong process để tránh auth lại nhiều lần
_DRIVE_SERVICE = None


def _today_str_vn() -> str:
    """Chuỗi ngày theo Asia/Ho_Chi_Minh dạng dd_mm_YYYY (fallback localtime nếu thiếu zoneinfo)."""
    try:
        from zoneinfo import ZoneInfo  # Python 3.9+
        tz = ZoneInfo("Asia/Ho_Chi_Minh")
        now = datetime.now(tz)
    except Exception:
        now = datetime.now()
    return now.strftime("%d_%m_%Y")


def get_drive_service(
    token_path: str = "token.json",
    credentials_path: str = "credentials.json",
    scopes: Optional[list] = None
):
    """
    Khởi tạo và trả về Drive service (được cache trong process).
    - token.json: lưu refresh token sau khi user cấp quyền
    - credentials.json: file OAuth client
    """
    global _DRIVE_SERVICE
    if _DRIVE_SERVICE is not None:
        return _DRIVE_SERVICE

    scopes = scopes or SCOPES

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, scopes)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            # Lưu ý: run_local_server chỉ phù hợp môi trường có trình duyệt.
            flow = InstalledAppFlow.from_client_secrets_file(credentials_path, scopes)
            creds = flow.run_local_server(port=0)
        with open(token_path, 'w') as token:
            token.write(creds.to_json())

    _DRIVE_SERVICE = build('drive', 'v3', credentials=creds)
    return _DRIVE_SERVICE


def _find_or_create_drive_folder(service, parent_id: str, folder_name: str) -> str:
    """
    Tìm folder theo tên trong parent_id. Không có thì tạo mới. Trả về folder_id.
    """
    query = (
        f"name = '{folder_name}' and "
        f"mimeType = 'application/vnd.google-apps.folder' and "
        f"'{parent_id}' in parents and trashed = false"
    )
    res = service.files().list(
        q=query,
        spaces='drive',
        fields='files(id, name)',
        pageSize=10
    ).execute()
    files = res.get('files', [])
    if files:
        return files[0]['id']

    metadata = {
        'name': folder_name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent_id]
    }
    folder = service.files().create(body=metadata, fields='id').execute()
    return folder['id']


def upload_to_drive(
    file_path: str,
    filename: str,
    parent_folder_id: str,
    *,
    use_date_subfolder: bool = True,
    token_path: str = "token.json",
    credentials_path: str = "credentials.json"
) -> str:
    """
    Upload file JPG lên Google Drive.
    - Nếu use_date_subfolder=True: tạo/tìm thư mục con theo ngày (dd_mm_YYYY) dưới parent_folder_id.
    - Trả về webViewLink của file upload.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File không tồn tại: {file_path}")

    service = get_drive_service(token_path=token_path, credentials_path=credentials_path)

    target_parent_id = parent_folder_id
    date_folder_name = None

    if use_date_subfolder:
        date_folder_name = _today_str_vn()
        target_parent_id = _find_or_create_drive_folder(service, parent_folder_id, date_folder_name)

    file_metadata = {
        'name': filename,
        'parents': [target_parent_id]
    }
    media = MediaFileUpload(file_path, mimetype='image/jpeg')

    uploaded_file = service.files().create(
        body=file_metadata,
        media_body=media,
        fields='id, webViewLink'
    ).execute()

    if date_folder_name:
        print(f"[UPLOAD] File uploaded to Drive (/{date_folder_name}): {uploaded_file['webViewLink']}")
    else:
        print(f"[UPLOAD] File uploaded to Drive (parent:{parent_folder_id}): {uploaded_file['webViewLink']}")

    return uploaded_file['webViewLink']


def _get_folder_weblink(folder_id: str) -> str:
    # Link xem/thư mục trên Drive
    return f"https://drive.google.com/drive/folders/{folder_id}"

def _ensure_nested_folders(service, root_parent_id: str, names: list[str]) -> str:
    """
    Tạo/kiếm chuỗi thư mục lồng nhau dưới root_parent_id theo thứ tự names.
    Trả về folder_id cuối cùng.
    """
    current_parent = root_parent_id
    for name in names:
        # tái sử dụng logic _find_or_create_drive_folder
        current_parent = _find_or_create_drive_folder(service, current_parent, name)
    return current_parent

def upload_to_drive_advanced(
    file_path: str,
    filename: str,
    parent_folder_id: str,
    *,
    use_date_subfolder: bool = True,
    order_subfolder: str | None = None,
    token_path: str = "token.json",
    credentials_path: str = "credentials.json",
    make_public_link: bool = False,
    return_folder_link: bool = False,
) -> dict:
    """
    Nâng cấp: cho phép upload theo đường dẫn: parent/(DATE)/(ORDER_ID)/filename
    Trả về dict: {"id": ..., "webViewLink": ..., "folderId": ..., "folderWebLink": ... (nếu yêu cầu)}
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File không tồn tại: {file_path}")

    service = get_drive_service(token_path=token_path, credentials_path=credentials_path)

    subfolders = []
    if use_date_subfolder:
        subfolders.append(_today_str_vn())
    if order_subfolder:
        subfolders.append(order_subfolder)

    # Tạo đường dẫn lồng nếu cần
    target_parent_id = parent_folder_id
    if subfolders:
        target_parent_id = _ensure_nested_folders(service, parent_folder_id, subfolders)

    file_metadata = {
        'name': filename,
        'parents': [target_parent_id]
    }
    media = MediaFileUpload(file_path, mimetype='image/jpeg')
    uploaded = service.files().create(
        body=file_metadata,
        media_body=media,
        fields='id, webViewLink, parents'
    ).execute()

    # Nếu muốn public link (optional)
    if make_public_link:
        service.permissions().create(
            fileId=uploaded['id'],
            body={'type': 'anyone', 'role': 'reader'},
            fields='id'
        ).execute()
        # lấy lại webViewLink để đảm bảo
        uploaded = service.files().get(fileId=uploaded['id'], fields='id, webViewLink, parents').execute()

    out = {
        "id": uploaded["id"],
        "webViewLink": uploaded["webViewLink"],
        "folderId": target_parent_id,
    }
    if return_folder_link:
        out["folderWebLink"] = _get_folder_weblink(target_parent_id)
    return out
