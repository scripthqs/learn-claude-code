# node fs

```ts
fs.readdirSync(d, { withFileTypes: true });
//withFileTypes:默认是false 返回该目录下的条目名
//返回 string[]
["SKILL.md", "README.md", "utils", "index.ts"]
//withFileTypes:true
//返回 fs.Dirent[]
[
  { name: "SKILL.md", isFile: [Function], isDirectory: [Function], isSymbolicLink: [Function], ... },
  { name: "utils",  isFile: [Function], isDirectory: [Function], ... }
]

// 返回的 name 只是文件/目录名；若需要完整路径 需要实用
// path.join(dir, ent.name)

// fs.readdirSync() 不承诺返回有确定顺序，遍历结果会受操作系统、文件系统、创建、缓存等影响
```

path.dirname： —— 取目录
path.resolve：就是终端模拟cd
path.join: 拼路径，会自动处理分隔符，多了去掉、少了补上，保证结果是格式正确的路径。

```js
path.dirname("/a/b/c.txt");
// /a/b
```

```bash
# path.resolve 就是在终端里 cd
cd /home/project
cd /etc/passwd    # 绝对路径，直接跳到根目录
# 当前位置：/etc/passwd

cd /home/project
cd ../../etc      # ../往上跳
# 当前位置：/etc

# 和 path.resolve 完全一致
# path.resolve("/home/project", "/etc/passwd")  // → "/etc/passwd"
# path.resolve("/home/project", "../../etc")    // → "/etc"
```

```js
path.join("/home/project", "/etc/passwd");
// → "/home/project/etc/passwd"
//                 ↑ 两个 / 合并成一个
path.join("/home/project/", "/etc/passwd");
// → "/home/project/etc/passwd"
//                 ↑ 同样合并
path.join("/home/project", "etc/passwd");
// → "/home/project/etc/passwd"
//                 ↑ 自动加上
```
