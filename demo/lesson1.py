from dotenv import load_dotenv
import os


load_dotenv()
api_key = os.getenv("ANTHROPIC_API_KEY")

print("API Key:", api_key)

# 变量
name = "alice"
count = 0

# 列表(list)
items = [1, 2, 3]
items.append(4)

# 字典(dict)
user = {"name": "Alice", "age": 30}

# f-string(模板字符串)
msg = f"hello,{name}!"

# 解构(unpacking)
first, *reset = items

# 条件
if count > 0:
    print("positive")
else:
    print("zero or negative")

doubled = [x * 2 for x in items]
print(doubled)
events = [x for x in items if x % 2 == 0]
print(events)

data = {"role": "user", "content": "Hello"}

# 安全取值（类似可选链）
content = data.get("content", "default content")
print(content)

# 合并
merged = {**data, "model": "gpt-4"}
print(merged)

# 解包
role, content = data["role"], data["content"]
print(role, content)


# 函数
def greet(name: str, greeting: str = "Hello") -> str:
    return f"{greeting}, {name}!"


# lambda表达式(类似箭头函数，但是只能单行)
add = lambda a, b: a + b  # noqa: E731


def addDef(a, b):
    return a + b


# 类(class)
class Agent:
    def __init__(self, name: str):
        # self 相当于 this，但必须显式写出
        self.name = name
        self.tools = []

    def add_tool(self, tool: str):
        self.tools.append(tool)
        return self  # 支持链式调用

    def act(self, observation: str) -> str:
        return f"{self.name} observes: {observation}"


agent = Agent("MyBot")  # 不需要 new


model = "claude-opus-4-6"
print(f"当前模型: {model}")

tools = ["search", "calculator"]
tools.append("weather")
print(f"tools_len: {len(tools)}")
print(f"tools[1]: {tools[1]}")

dicts = {"role": "user", "content": "你好"}
print(f"content: {dicts['content']}")

add_numbers = lambda a, b: a + b  # noqa: E731
print(f"add_numbers(2, 3): {add_numbers(2, 3)}")


def add_numbers_def(a, b):
    return a + b


for x in tools:
    print(f"工具: {x}")


arr = ["a", "b", "c"]
for i, v in enumerate(arr):  # i = 0,1,2
    print(i, v)

msg = """第一行
第二行
第三行"""
print(msg)
