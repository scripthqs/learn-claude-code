import os
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv(override=True)

if os.getenv("ANTHROPIC_BASE_URL"):
    os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

client = Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
MODEL = os.environ["MODEL_ID"]
SYSTEM = '你是一个严格的编程老师，回答只能用中文，且每次回答不超过 50 个字'

def chat(history: list,user_input: str) -> tuple[str, list]:

    history.append({"role": "user", "content": user_input})

    response = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM,
        messages=history,
    )
    ai_reply = response.content[0].text

    history.append({"role": "assistant", "content": ai_reply})

    return ai_reply, history

history = []

response, history = chat(history,"用一句话解释什么是 AI Agent")
print(response)

response, history = chat(history,"什么是函数")
print(response)

response, history = chat(history,"我叫小明，我是一个前端工程师")
print(response)

response, history = chat(history,"我想学 AI Agent 开发")
print(response)

response, history = chat(history,"你还记得我叫什么名字吗？")
print(response)