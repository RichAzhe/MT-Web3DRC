本地解压后，在根目录下终端执行  npm install  构建项目

然后打开 redis-server.exe 以模拟缓存

随后终端执行 node server.js启动项目模拟后端

新开终端执行 node cloud-server.js启动模拟云端节点

最后在浏览器输入  https://localhost:3000 查看界面

（注：Cache为缓存文件夹，初始状态默认为空，模型文件放到models下）

