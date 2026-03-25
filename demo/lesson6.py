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
    "姓名：张伟，年龄：28岁，现居城市：深圳",
    "教育背景：毕业于华南理工大学，计算机科学与技术专业，本科学历",
    "前端技能：熟练掌握 Vue3、React、TypeScript、HTML、CSS",
    "工具技能：熟悉 Webpack、Vite、Git、VSCode、Figma",
    "第一份工作：2018年至2021年在腾讯担任前端工程师，负责微信小程序开发",
    "第二份工作：2021年至今在字节跳动担任高级前端工程师，负责抖音 PC 端开发",
    "项目经历一：主导开发了字节跳动内部低代码平台，支持拖拽生成页面，日活用户 3000+",
    "项目经历二：在腾讯期间独立开发了一款企业微信考勤小程序，覆盖 50 家企业",
    "其他技能：了解 Python、Node.js，有 AI Agent 开发学习经验",
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
print(rag_answer("他有哪些前端技能？"))
print(rag_answer("做过什么项目？"))
print(rag_answer("在哪些公司工作过？"))
