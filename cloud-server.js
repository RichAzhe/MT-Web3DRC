const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3001; // 模拟云端节点

// 1. 基础配置
app.use(cors());
app.use(express.json());

// 2. 模拟网络延迟 (WAN Latency)
// 论文中云端通信通常有 50ms-200ms 的延迟
// 注意：必须放在 static 中间件之前，否则下载模型文件不会有延迟
app.use((req, res, next) => {
    const latency = Math.floor(Math.random() * 150) + 50; // 50-200ms
    setTimeout(next, latency);
});

// 模拟云端存储：完整的模型库 (LOD 0/1/2/3)
// 实际部署时，这里通常是对象存储 (S3) 或分布式文件系统
app.use('/models', express.static(path.join(__dirname, 'models')));

// 3. 核心接口：获取模型块 (Source of Truth)
app.get('/api/cloud/get-block', (req, res) => {
    const modelId = req.query.modelId;
    const lodLevel = req.query.lodLevel || '1';

    if (!modelId) {
        return res.status(400).json({ code: 400, msg: '缺少 modelId 参数' });
    }

    console.log(`☁️ [Cloud] 收到请求: ${modelId} (LOD ${lodLevel})`);

    // 简单检查文件是否存在
    const filePath = path.join(__dirname, 'models', modelId, 'scene.gltf');
    // 注意：这里为了演示，假设所有 LOD 都映射到同一个文件或特定命名规则
    // 实际项目中应根据 lodLevel 返回不同精度的文件

    if (fs.existsSync(filePath)) {
        res.json({
            code: 200,
            msg: '云端获取成功',
            data: {
                url: `http://localhost:${port}/models/${modelId}/scene.gltf`, // 返回云端直链
                origin: 'cloud-server',
                latency: 'high' // 标记为高延迟源
            }
        });
    } else if (modelId.startsWith('grid_')) {
        // 虚拟块兜底：动态寻找一个存在的模型作为替身
        // 避免硬编码 'headphone_retro'，提高灵活性
        let dummyId = 'headphone_retro'; // Default
        try {
            const modelsDir = path.join(__dirname, 'models');
            if (fs.existsSync(modelsDir)) {
                const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
                const firstModel = entries.find(entry => entry.isDirectory());
                if (firstModel) {
                    dummyId = firstModel.name;
                }
            }
        } catch (e) {
            console.warn('无法动态获取模型列表，使用默认值');
        }

        const dummyPath = path.join(__dirname, 'models', dummyId, 'scene.gltf');

        if (fs.existsSync(dummyPath)) {
            res.json({
                code: 200,
                msg: '云端获取成功 (Virtual)',
                data: {
                    url: `http://localhost:${port}/models/${dummyId}/scene.gltf`,
                    origin: 'cloud-server-virtual',
                    latency: 'high'
                }
            });
        } else {
            res.status(404).json({ code: 404, msg: '云端无法找到任何可用模型作为虚拟块替身' });
        }
    } else {
        res.status(404).json({ code: 404, msg: '云端模型未找到' });
    }
});

// 4. 启动服务
app.listen(port, () => {
    console.log(`☁️ [Cloud Server] 云端节点启动：http://localhost:${port}`);
    console.log(`   - 模拟延迟: 50-200ms`);
    console.log(`   - 角色: 数据源站 (Source of Truth)`);
});
