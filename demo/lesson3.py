import os
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv(override=True)

if os.getenv("ANTHROPIC_BASE_URL"):
    os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

client = Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
MODEL = os.environ["MODEL_ID"]
SYSTEM = "你是一个AI助手，回答只能用中文，且每次回答不超过 50 个字,另外你可以使用工具"

TOOLS = [
    {
        "name": "get_weather",  # 工具名
        "description": "获取指定城市的天气情况",  # 描述，Claude 靠这个决定要不要用
        "input_schema": {  # 参数结构，用 JSON Schema 格式
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称，例如：北京、上海"}
            },
            "required": ["city"],  # 必填参数
        },
    },
    {
        "name": "calculator",
        "description": "一个简单的计算器，支持加减乘除",
        "input_schema": {
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "第一个数字"},
                "b": {"type": "number", "description": "第二个数字"},
                "operation": {
                    "type": "string",
                    "description": '操作类型，必须是 "add"、"subtract"、"multiply" 或 "divide"',
                },
            },
            "required": ["a", "b", "operation"],
        },
    },
]


def get_weather(city: str) -> str:
    weather_data = {
        "北京": "晴，25°C，空气质量良好",
        "上海": "多云，22°C，湿度较高",
        "广州": "小雨，28°C，注意带伞",
    }
    return weather_data.get(city, f"{city}：暂无天气数据")


def calculator(a: float, b: float, operation: str) -> float:
    if operation == "add":
        return a + b
    elif operation == "subtract":
        return a - b
    elif operation == "multiply":
        return a * b
    elif operation == "divide":
        return a / b if b != 0 else "Error: Division by zero"
    else:
        return f"Unknown operation: {operation}"


TOOL_HANDLERS = {
    "get_weather": lambda **kw: get_weather(kw["city"]),
    "calculator": lambda **kw: calculator(kw["a"], kw["b"], kw["operation"]),
}


def run_with_tools(messages: list):
    while True:
        response = client.messages.create(
            model=MODEL,
            system=SYSTEM,
            messages=messages,
            tools=TOOLS,
            max_tokens=1024,
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            print(response.content[0].text)  # 加这行
            return
        results = []
        for block in response.content:
            if block.type == "tool_use":
                handler = TOOL_HANDLERS.get(block.name)
                output = str(
                    handler(**block.input) if handler else f"Unknown tool: {block.name}"
                )
                print(f"> {block.name}: {output}")
                results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": output}
                )
        messages.append({"role": "user", "content": results})


# 改成这样
run_with_tools([{"role": "user", "content": "广州天气怎么样？"}])
run_with_tools([{"role": "user", "content": "12 乘以 8 等于多少？"}])
run_with_tools([{"role": "user", "content": "用一句话介绍一下你自己"}])
