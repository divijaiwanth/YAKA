from fastapi import FastAPI

app = FastAPI(title="Yaka")


@app.get("/health")
def health():
    return {"status": "ok"}
