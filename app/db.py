import os

from supabase import Client, create_client

_client: Client | None = None


def get_db() -> Client:
    """Server-side Supabase client, using the secret key (bypasses RLS).

    Never expose this key or this client's usage pattern to the frontend —
    the frontend goes through FastAPI, never Supabase directly.
    """
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SECRET_KEY"],
        )
    return _client
