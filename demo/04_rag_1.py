import os

from anthropic import Anthropic
from dotenv import load_dotenv

import numpy as np  # 数学计算库

load_dotenv(override=True)

if os.getenv("ANTHROPIC_BASE_URL"):
    os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

client = Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
MODEL = os.environ["MODEL_ID"]
SYSTEM = "你是一个AI助手，回答只能用中文，且每次回答不超过 50 个字,另外你可以使用工具"


documents = [
    "Python 是一种高级编程语言，以简洁易读著称，广泛用于 AI、数据科学和 Web 开发。",
    "JavaScript 是前端开发的核心语言，运行在浏览器中，也可以通过 Node.js 运行在服务端。",
    "RAG 全称检索增强生成，通过在提问时检索相关文档片段，让 AI 能回答私有数据相关的问题。",
    "LangChain 是一个 AI 应用开发框架，封装了常用的 LLM 调用、RAG、Agent 等模式。",
    "向量数据库专门存储和搜索向量，常见的有 Chroma、Pinecone、Weaviate 等。",
    "Function Calling 允许 AI 调用开发者定义的工具函数，是构建 AI Agent 的核心能力。",
    "Embedding 是把文字转换成数字向量的技术，语义相近的文字转换后的向量也相近。",
    "Claude 是 Anthropic 开发的 AI 助手，擅长代码、写作、分析等多种任务。",
]


def get_embedding(text: str) -> list[float]:
    """调用 Anthropic API 获取文本的向量表示"""
    # 注意：这里用一个小技巧，用 Claude 来生成简单的语义向量
    # 真实项目用专门的 embedding 模型，比如 voyage-3
    # 这里为了不引入新 API，我们用余弦相似度的简化版
    # 实际上 Anthropic 有 voyage embedding API 可以直接用
    pass  # 下面会解释怎么处理


# 因为 Anthropic 的 embedding API 需要单独申请
# 这里我们用一个简化方案：TF-IDF 风格的词频向量
# 足够演示 RAG 原理


# 把知识库转成文档向量
def simple_embedding(text: str, vocab: list[str]) -> np.ndarray:
    """简单的词频向量，用于演示"""
    # 创建一个全是零的向量，长度等于词汇表大小
    vector = np.zeros(len(vocab))

    words = text.lower().split()
    # 遍历词汇表，统计每个词在文字里出现几次，填入向量对应位置。
    for i, word in enumerate(vocab):
        vector[i] = words.count(word)
    # 归一化
    # 计算向量长度
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else vector


# 和每条文档比较，计算相似度
def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """计算两个向量的余弦相似度，值越大越相似"""
    # 计算两个向量的相似度。np.dot 是点积运算，归一化之后的向量点积就等于余弦相似度。返回值 0~1，越接近 1 越相似。
    return float(np.dot(a, b))


# 建立词汇表（从所有文档提取）
all_words = list(set(word for doc in documents for word in doc.lower().split()))
print(f"词汇表大小: {len(all_words)}，示例词汇: {all_words}")
# 给每个文档生成向量
doc_embeddings = [simple_embedding(doc, all_words) for doc in documents]

print(f"文档库建立完成，共 {len(documents)} 条文档")

# ─── 阶段二：查询 ────────────────────────────────


def search(query: str, top_k: int = 3) -> list[str]:
    """语义搜索：找出最相关的 top_k 条文档"""
    query_embedding = simple_embedding(query, all_words)

    # 计算 query 和每条文档的相似度
    similarities = [
        cosine_similarity(query_embedding, doc_emb) for doc_emb in doc_embeddings
    ]

    # 取相似度最高的 top_k 条
    # 排序但返回下标
    top_indices = np.argsort(similarities)[-top_k:][::-1]

    results = []
    for idx in top_indices:
        results.append(documents[idx])
        print(f"  [相似度 {similarities[idx]:.3f}] {documents[idx][:30]}...")

    return results


def rag_answer(question: str) -> str:
    """RAG 问答：检索 + 生成"""
    print(f"\n问题：{question}")
    print("检索中...")

    # 1. 检索相关文档
    relevant_docs = search(question)

    # 2. 组合 prompt
    context = "\n".join(f"- {doc}" for doc in relevant_docs)
    prompt = f"""根据以下资料回答问题，只能基于资料内容回答，不要编造信息。

资料：
{context}

问题：{question}"""

    # 3. 发给 Claude
    response = client.messages.create(
        model=MODEL, max_tokens=512, messages=[{"role": "user", "content": prompt}]
    )

    return response.content[0].text


# 测试
print(rag_answer("什么是 RAG？"))
print(rag_answer("向量数据库有哪些？"))
print(rag_answer("Claude 是谁开发的？"))
