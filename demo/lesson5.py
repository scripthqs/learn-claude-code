import os

from anthropic import Anthropic
from dotenv import load_dotenv

import numpy as np
from sentence_transformers import SentenceTransformer

load_dotenv(override=True)

if os.getenv("ANTHROPIC_BASE_URL"):
    os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

client = Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
embedding_model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")

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


def get_embeddings(texts: list[str]) -> list[list[float]]:
    """批量获取文本向量"""
    return embedding_model.encode(texts).tolist()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """计算余弦相似度"""
    a = np.array(a)
    b = np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


doc_embeddings = get_embeddings(documents)


print(f"文档库建立完成，共 {len(documents)} 条文档")

# ─── 阶段二：查询 ────────────────────────────────


def search(query: str, top_k: int = 3) -> list[str]:
    """语义搜索：找出最相关的 top_k 条文档"""
    query_embedding = get_embeddings([query])[0]

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
