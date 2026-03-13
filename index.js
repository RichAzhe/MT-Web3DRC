/*
修复点清单：
1. 补全并确保渲染循环使用 requestAnimationFrame 驱动；
2. 完整定义 loadMainModel 并在初始化时触发首个模型加载；
3. 定义 isVsyncOff 默认值避免 ReferenceError；
4. 补全 loadGltfBlock 加载闭环与异常处理；
5. DOM 访问增加存在性校验，避免空引用报错；
6. 保留 TaskQueue、FrameRateManager、预取策略、性能监控与分块加载缓存逻辑。
*/
import * as THREE from '/node_modules/three/build/three.module.js';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '/node_modules/three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from '/node_modules/three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';

let isVsyncOff = false;

const getEl = (id) => document.getElementById(id);
const setText = (id, text) => {
    const el = getEl(id);
    if (el) el.textContent = text;
    return el;
};

// --- FrameRateManager Start ---
class FrameRateManager {
    constructor() {
        this.targetFPS = 60;
        this.frameInterval = 1000 / 60;
        this.lastFrameTime = 0;
        this.enabled = true;
        this.loadMode = 'none'; // none, low, medium, high, custom
        this.customLoadMs = 20;
        this.anomalies = [];
        this.totalAnomalies = 0;
    }

    setTargetFPS(fps) {
        this.targetFPS = fps;
        this.frameInterval = 1000 / fps;
        this.anomalies = [];
        this.totalAnomalies = 0;
    }

    // For rAF loop (VSync ON): return true if we should render this frame
    shouldRender(timestamp) {
        if (!this.enabled) return true;
        const elapsed = timestamp - this.lastFrameTime;
        return elapsed >= (this.frameInterval - 0.5);
    }

    // For setTimeout loop (VSync OFF): return delay in ms for next frame
    getNextFrameDelay(timestamp) {
        if (!this.enabled) return 0;
        const elapsed = timestamp - this.lastFrameTime;
        const remaining = this.frameInterval - elapsed;
        return Math.max(0, remaining);
    }

    updateLastFrameTime(timestamp) {
        // Align to grid for smoother frame pacing in VSync ON
        if (!isVsyncOff && this.enabled) {
            const elapsed = timestamp - this.lastFrameTime;
            if (this.frameInterval > 0) {
                this.lastFrameTime = timestamp - (elapsed % this.frameInterval);
            } else {
                this.lastFrameTime = timestamp;
            }
        } else {
            this.lastFrameTime = timestamp;
        }
    }

    recordAnomaly(fps) {
        this.anomalies.push({ time: Date.now(), fps });
        if (this.anomalies.length > 50) this.anomalies.shift(); // Keep last 50
        this.totalAnomalies++;
    }

    simulateLoad() {
        let loadMs = 0;
        switch (this.loadMode) {
            case 'low': loadMs = 5; break;
            case 'medium': loadMs = 15; break;
            case 'high': loadMs = 30; break;
            case 'custom': loadMs = this.customLoadMs; break;
            default: return;
        }

        if (loadMs > 0) {
            const start = performance.now();
            while (performance.now() - start < loadMs) {
                // busy wait
            }
        }
    }
}
const fpsManager = new FrameRateManager();
// --- FrameRateManager End ---

class StabilityMonitor {
    constructor(windowSize = 240) {
        this.windowSize = windowSize;
        this.samples = [];
    }

    record(sample) {
        this.samples.push(sample);
        if (this.samples.length > this.windowSize) {
            this.samples.shift();
        }
    }

    getStats() {
        const fpsSamples = this.samples.map(s => s.fps).filter(v => Number.isFinite(v));
        if (fpsSamples.length === 0) {
            return {
                min: 0, max: 0, avg: 0, stdDev: 0, cv: 0, rangePct: 0, stable: 0
            };
        }
        const total = fpsSamples.reduce((a, b) => a + b, 0);
        const avg = total / fpsSamples.length;
        const min = Math.min(...fpsSamples);
        const max = Math.max(...fpsSamples);
        const squareDiffs = fpsSamples.map(value => Math.pow(value - avg, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / fpsSamples.length;
        const stdDev = Math.sqrt(avgSquareDiff);
        const cv = avg > 0 ? stdDev / avg : 0;
        const rangePct = avg > 0 ? ((max - min) / avg) * 100 : 0;
        
        // 计算稳定帧率 (去除波动较大的帧)
        const threshold = avg * 0.1; // 10%的阈值
        const stableSamples = fpsSamples.filter(fps => Math.abs(fps - avg) <= threshold);
        const stableAvg = stableSamples.length > 0 ? 
            stableSamples.reduce((a, b) => a + b, 0) / stableSamples.length : avg;
        
        return { min, max, avg, stdDev, cv, rangePct, stable: stableAvg };
    }
}

function computeBoxPlot(samples) {
    if (!samples || samples.length === 0) {
        return { min: 0, q1: 0, median: 0, q3: 0, max: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const pick = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
    return {
        min: sorted[0],
        q1: pick(0.25),
        median: pick(0.5),
        q3: pick(0.75),
        max: sorted[sorted.length - 1]
    };
}

/**
 * 从排序后的FPS样本中找到最连贯的数据段
 * 使用滑动窗口方法找出最大值和最小值差最小的连续段
 * @param {number[]} sortedSamples - 已排序的FPS样本数组
 * @param {number} minWindowSize - 最小窗口大小，默认为总样本数的10%
 * @returns {Object} 包含startIndex和endIndex的对象
 */
function findMostCoherentSegment(sortedSamples, minWindowSize = null) {
    if (!sortedSamples || sortedSamples.length === 0) {
        return { startIndex: 0, endIndex: 0 };
    }
    
    const n = sortedSamples.length;
    
    // 如果没有指定最小窗口大小，默认为总样本数的10%，但至少为3个样本
    if (minWindowSize === null) {
        minWindowSize = Math.max(3, Math.floor(n * 0.1));
    }
    
    // 确保最小窗口大小不超过总样本数
    minWindowSize = Math.min(minWindowSize, n);
    
    let bestStart = 0;
    let bestEnd = n - 1;
    let minRange = Infinity;
    
    // 滑动窗口遍历所有可能的连续段
    for (let windowSize = minWindowSize; windowSize <= n; windowSize++) {
        for (let start = 0; start <= n - windowSize; start++) {
            const end = start + windowSize - 1;
            const segment = sortedSamples.slice(start, end + 1);
            
            // 计算该段的最大值和最小值
            const minVal = Math.min(...segment);
            const maxVal = Math.max(...segment);
            const range = maxVal - minVal;
            
            // 如果范围更小，更新最佳段
            if (range < minRange) {
                minRange = range;
                bestStart = start;
                bestEnd = end;
            }
        }
    }
    
    return {
        startIndex: bestStart,
        endIndex: bestEnd
    };
}

function getModelScale(sizeMB) {
    if (!Number.isFinite(sizeMB)) return 'medium';
    if (sizeMB < 2) return 'small';
    if (sizeMB >= 20) return 'large';
    return 'medium';
}

// --- GPU Simulation & VRAM Management ---

class GPUSimulator {
    constructor(renderer, scene, camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.stressMesh = null;
        this.stressMaterial = null;
        this.stressLevel = 0;
    }

    initShaderStress() {
        if (this.stressMesh) return;

        // 创建一个始终位于相机前方的全屏平面
        // 使用 RawShaderMaterial 避免 Three.js 内置光照计算干扰
        // 但为了简单集成到现有场景，我们将其作为相机的子对象
        const geometry = new THREE.PlaneGeometry(2, 2); // NDC 全屏

        this.stressMaterial = new THREE.ShaderMaterial({
            uniforms: {
                stressLevel: { value: 0 }
            },
            vertexShader: `
                void main() {
                    // 忽略变换矩阵，直接输出全屏坐标
                    gl_Position = vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float stressLevel;
                void main() {
                    float val = 0.0;
                    // 模拟繁重计算循环
                    // WebGL 循环次数必须是常量或受限，这里使用固定上限 + break
                    for(int i = 0; i < 5000; i++) {
                        if (float(i) >= stressLevel) break;
                        val += sin(float(i) * 0.1) * cos(float(i) * 0.2);
                    }
                    // 防止编译器优化掉循环
                    if (val > 1000000.0) discard;
                    
                    // 输出几乎透明的颜色
                    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.001); 
                }
            `,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        this.stressMesh = new THREE.Mesh(geometry, this.stressMaterial);
        // 渲染顺序设为最后，确保它在所有物体之后绘制（覆盖全屏）
        // 或者最前？作为全屏后处理效果
        this.stressMesh.renderOrder = 9999;
        this.stressMesh.frustumCulled = false;

        // 不需要添加到场景，直接在 renderLoop 中作为一个独立的 pass 渲染更好
        // 但为了复用现有 renderLoop，我们将其添加到 scene，但需要确保它总是覆盖屏幕
        // 方法2：添加到相机
        this.camera.add(this.stressMesh);
        this.scene.add(this.camera);
    }

    setStressLevel(level) {
        this.stressLevel = level;
        if (level > 0) {
            if (!this.stressMesh) this.initShaderStress();
            this.stressMaterial.uniforms.stressLevel.value = level;
            this.stressMesh.visible = true;
        } else {
            if (this.stressMesh) this.stressMesh.visible = false;
        }
    }

    setResolutionScale(scale) {
        this.renderer.setPixelRatio(window.devicePixelRatio * scale);
        // 触发 resize 以应用新的 buffer size
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
}

const vramManager = {
    currentMB: 0,
    limitMB: 1024, // 默认 1GB，后续会动态更新
    textureRefs: new Map(), // UUID -> count
    geometryRefs: new Map(), // 新增：UUID -> count (几何体引用计数)

    // 新增：初始化动态显存上限
    init(renderer) {
        const gl = renderer.getContext();
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const rendererName = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '';

        // 1. 尝试估算设备显存
        // WebGL 不直接暴露 VRAM 大小，使用 navigator.deviceMemory (RAM) 作为启发式依据
        // 通常显存约为 RAM 的 1/4 ~ 1/2，或根据桌面/移动端区分
        let estimatedVRAM = 1024;

        const ram = navigator.deviceMemory || 4; // 默认为 4GB
        if (ram >= 16) estimatedVRAM = 8192; // 16GB RAM -> ~8GB VRAM (High-end)
        else if (ram >= 8) estimatedVRAM = 4096; // 8GB RAM -> ~4GB VRAM
        else if (ram >= 4) estimatedVRAM = 2048; // 4GB RAM -> ~2GB VRAM
        else estimatedVRAM = 1024; // Low-end

        // 2. 帧缓冲区开销 (Framebuffer Overhead)
        // 估算：Screen Width * Height * 4 (RGBA) * Depth/Stencil * Double Buffering
        const width = window.innerWidth;
        const height = window.innerHeight;
        const dpr = window.devicePixelRatio || 1;
        // Color (4 bytes) + Depth/Stencil (4 bytes) * Front/Back Buffer (2)
        const framebufferMB = (width * height * dpr * dpr * 8 * 2) / (1024 * 1024);

        this.currentMB += framebufferMB;
        this.limitMB = estimatedVRAM;

        console.log(`🎮 [VRAM Init] Renderer: ${rendererName}`);
        console.log(`🎮 [VRAM Init] System RAM: ${ram}GB, Estimated VRAM Limit: ${this.limitMB}MB`);
        console.log(`🎮 [VRAM Init] Initial Framebuffer Overhead: ${framebufferMB.toFixed(1)}MB`);

        this.updateDisplay();
    },

    /**
     * Calculate how much *new* VRAM this group will consume
     * (excluding textures/geometries already loaded)
     */
    getIncrementalSize(group) {
        let addedSize = 0;
        const seenTextures = new Set();
        const seenGeometries = new Set();

        group.traverse(node => {
            if (node.isMesh) {
                // 1. Geometry Calculation (Vertices + Indices)
                if (node.geometry) {
                    const uuid = node.geometry.uuid;
                    if (!seenGeometries.has(uuid)) {
                        seenGeometries.add(uuid);
                        // 检查是否全局已存在
                        if (!this.geometryRefs.has(uuid) || this.geometryRefs.get(uuid) === 0) {
                            // Attributes
                            for (const name in node.geometry.attributes) {
                                const attr = node.geometry.attributes[name];
                                addedSize += (attr.count * attr.itemSize * 4) / (1024 * 1024); // 4 bytes per float
                            }
                            // Indices
                            if (node.geometry.index) {
                                addedSize += (node.geometry.index.count * 4) / (1024 * 1024); // Assume 32-bit indices for safety
                            }
                        }
                    }
                }

                // 2. Texture Calculation
                if (node.material) {
                    const materials = Array.isArray(node.material) ? node.material : [node.material];
                    materials.forEach(mat => {
                        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach(mapType => {
                            if (mat[mapType] && mat[mapType].image) {
                                const uuid = mat[mapType].uuid;
                                if (!seenTextures.has(uuid)) {
                                    seenTextures.add(uuid);
                                    if (!this.textureRefs.has(uuid) || this.textureRefs.get(uuid) === 0) {
                                        const img = mat[mapType].image;
                                        const w = img.width || 1024;
                                        const h = img.height || 1024;

                                        // Mipmap check
                                        let factor = 1.33;
                                        if (mat[mapType].minFilter === 1003 || mat[mapType].minFilter === 1006) {
                                            factor = 1.0;
                                        }

                                        addedSize += (w * h * 4 * factor) / (1024 * 1024);
                                    }
                                }
                            }
                        });
                    });
                }
            }
        });
        return addedSize;
    },

    /**
     * Register resources in this group
     */
    track(group) {
        let addedSize = 0;
        const seenTextures = new Set();
        const seenGeometries = new Set();

        group.traverse(node => {
            if (node.isMesh) {
                // Geometry Tracking
                if (node.geometry) {
                    const uuid = node.geometry.uuid;
                    if (!seenGeometries.has(uuid)) {
                        seenGeometries.add(uuid);
                        const count = this.geometryRefs.get(uuid) || 0;
                        this.geometryRefs.set(uuid, count + 1);

                        if (count === 0) {
                            // Attributes
                            for (const name in node.geometry.attributes) {
                                const attr = node.geometry.attributes[name];
                                addedSize += (attr.count * attr.itemSize * 4) / (1024 * 1024);
                            }
                            // Indices
                            if (node.geometry.index) {
                                addedSize += (node.geometry.index.count * 4) / (1024 * 1024);
                            }
                        }
                    }
                }

                // Texture Tracking
                if (node.material) {
                    const materials = Array.isArray(node.material) ? node.material : [node.material];
                    materials.forEach(mat => {
                        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach(mapType => {
                            if (mat[mapType] && mat[mapType].image) {
                                const uuid = mat[mapType].uuid;
                                if (!seenTextures.has(uuid)) {
                                    seenTextures.add(uuid);
                                    const count = this.textureRefs.get(uuid) || 0;
                                    this.textureRefs.set(uuid, count + 1);

                                    if (count === 0) {
                                        const img = mat[mapType].image;
                                        const w = img.width || 1024;
                                        const h = img.height || 1024;

                                        let factor = 1.33;
                                        if (mat[mapType].minFilter === 1003 || mat[mapType].minFilter === 1006) {
                                            factor = 1.0;
                                        }

                                        addedSize += (w * h * 4 * factor) / (1024 * 1024);
                                    }
                                }
                            }
                       });
                    });
                }
            }
        });
        this.currentMB += addedSize;
        this.updateDisplay();
        return addedSize;
    },

    /**
     * Unregister resources
     */
    untrack(group) {
        let removedSize = 0;
        const seenTextures = new Set();
        const seenGeometries = new Set();

        group.traverse(node => {
            if (node.isMesh) {
                // Geometry Untracking
                if (node.geometry) {
                    const uuid = node.geometry.uuid;
                    if (!seenGeometries.has(uuid)) {
                        seenGeometries.add(uuid);
                        const count = this.geometryRefs.get(uuid) || 0;
                        if (count > 0) {
                            this.geometryRefs.set(uuid, count - 1);
                            if (count - 1 === 0) {
                                for (const name in node.geometry.attributes) {
                                    const attr = node.geometry.attributes[name];
                                    removedSize += (attr.count * attr.itemSize * 4) / (1024 * 1024);
                                }
                                if (node.geometry.index) {
                                    removedSize += (node.geometry.index.count * 4) / (1024 * 1024);
                                }
                                this.geometryRefs.delete(uuid);
                                node.geometry.dispose(); // Thoroughly release geometry
                            }
                        }
                    }
                }

                // Texture Untracking
                if (node.material) {
                    const materials = Array.isArray(node.material) ? node.material : [node.material];
                    materials.forEach(mat => {
                        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach(mapType => {
                            if (mat[mapType] && mat[mapType].image) {
                                const uuid = mat[mapType].uuid;
                                if (!seenTextures.has(uuid)) {
                                    seenTextures.add(uuid);
                                    const count = this.textureRefs.get(uuid) || 0;
                                    if (count > 0) {
                                        this.textureRefs.set(uuid, count - 1);
                                        if (count - 1 === 0) {
                                            const img = mat[mapType].image;
                                            const w = img.width || 1024;
                                            const h = img.height || 1024;

                                            let factor = 1.33;
                                            if (mat[mapType].minFilter === 1003 || mat[mapType].minFilter === 1006) {
                                                factor = 1.0;
                                            }

                                            removedSize += (w * h * 4 * factor) / (1024 * 1024);
                                            this.textureRefs.delete(uuid);
                                            mat[mapType].dispose(); // Thoroughly release texture
                                        }
                                    }
                                }
                            }
                       });
                    });
                }
            }
        });
        this.currentMB = Math.max(0, this.currentMB - removedSize);
        this.updateDisplay();
    },

    checkLimit(newSizeMB) {
        return (this.currentMB + newSizeMB) <= this.limitMB;
    },

    // Legacy method support (for simulated blocks)
    add(sizeMB) {
        this.currentMB += sizeMB;
        this.updateDisplay();
    },

    remove(sizeMB) {
        this.currentMB = Math.max(0, this.currentMB - sizeMB);
        this.updateDisplay();
    },

    updateDisplay() {
        const el = getEl('vram-usage-display');
        if (el) {
            const pct = (this.currentMB / this.limitMB * 100).toFixed(1);
            el.textContent = `(${this.currentMB.toFixed(1)}MB / ${pct}%)`;
            el.style.color = this.currentMB > this.limitMB ? '#ff5555' : '#aaa';

            // Tooltip or console log for details (optional)
            el.title = `Tex: ${this.getTextureSizeMB().toFixed(1)}MB, Geo: ${this.getGeometrySizeMB().toFixed(1)}MB`;
        }
    },

    /**
     * 重置显存计数器 (用于 Benchmark 重置场景)
     */
    reset() {
        // 保留 Framebuffer 开销
        const width = window.innerWidth;
        const height = window.innerHeight;
        const dpr = window.devicePixelRatio || 1;
        const framebufferMB = (width * height * dpr * dpr * 8 * 2) / (1024 * 1024);

        this.currentMB = framebufferMB;
        this.textureRefs.clear();
        this.geometryRefs.clear();
        this.updateDisplay();
        console.log('🧹 [VRAM Manager] Reset complete.');
    },

    getTextureSizeMB() {
        // Simple heuristic: Total - Geo - Framebuffer (approx)
        // Or track separately if needed. For now, let's just log in console when debugging.
        return 0;
    },

    getGeometrySizeMB() {
        return 0;
    }
};

// Deprecated: Logic moved to vramManager.getIncrementalSize
function calculateTextureSizeMB(object) {
    return vramManager.getIncrementalSize(object);
}

// 统一卸载块逻辑 (优化：异步卸载，避免主线程卡顿)
function unloadBlock(key) {
    if (!loadedBlocks.has(key)) return;
    const group = loadedBlocks.get(key);

    // VRAM Update (Immediately update counter logic)
    if (group.userData.trackedByManager) {
        vramManager.untrack(group);
    } else if (group.userData.vramSize) {
        vramManager.remove(group.userData.vramSize);
    }

    scene.remove(group);
    loadedBlocks.delete(key);

    // Dispose resources asynchronously (Schedule in next macro-task)
    setTimeout(() => {
        group.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                else obj.material.dispose();
            }
            // Texture disposal is handled by VRAMManager's reference counting if implemented
            // or implicitly by GC if no references remain.
            // Explicit disposal of textures would require tracking which textures are unique to this model,
            // which vramManager now does via reference counting.
            // Ideally vramManager should return a list of textures to dispose, but Three.js handles it well enough.
        });
        // console.log(`🗑️ [Async Dispose] Resources freed for ${key}`);
    }, 0);
}

const stabilityConfig = {
    warmupFrames: 60,
    smallModelMB: 2,
    largeModelMB: 20,
    targetFps: 60,
    maxLod: 3,
    minLod: 1,
    baseMaxBlocks: 6,
    maxTriangles: 0 // 关闭基于三角形数量的GPU预算自适应（0 表示不限制）
};

const stabilityMonitor = new StabilityMonitor();
let stabilityState = {
    lodBias: 0,
    maxBlocksOverride: null,
    proxyDistance: 140
};
const modelSizeCache = new Map();
let currentModelSizeMB = 0;
let currentModelScale = 'medium';
let proxyMesh = null;
let proxyCapacity = 0;
const proxyIndexMap = new Map();

// 初始化 Stats
const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
const statsContainer = getEl('stats-container');
if (statsContainer) {
    statsContainer.appendChild(stats.dom);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a); // 深灰色背景，避免纯黑看不清模型
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// 初始化 VRAM 管理器
vramManager.init(renderer);

// 添加轨道控制器 (鼠标左键旋转，右键平移，滚轮缩放)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 开启阻尼效果，更有质感
controls.dampingFactor = 0.05;

const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);
camera.position.z = 10;

// 增强光照系统
const ambient = new THREE.AmbientLight(0xffffff, 1.2); // 增强环境光
const dir1 = new THREE.DirectionalLight(0xffffff, 1.0); // 主平行光
dir1.position.set(5, 10, 7);
const dir2 = new THREE.DirectionalLight(0xffffff, 0.5); // 补光，从背后照入
dir2.position.set(-5, -5, -5);

scene.add(ambient);
scene.add(dir1);
scene.add(dir2);

const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
gltfLoader.setDRACOLoader(dracoLoader);
const loadedBlocks = new Map(); // key: blockId_lodLevel, value: THREE.Group
const loadingBlocks = new Set(); // 正在加载中的块，避免重复请求
const geometryCache = new Map(); // key: baseModelId_lodLevel, value: Promise<THREE.Group>


// --- Time-Budgeted Task Queue ---
class TaskQueue {
    constructor(budgetMs = 5) {
        this.tasks = [];
        this.budgetMs = budgetMs;
    }

    enqueue(task, priority = 0) {
        this.tasks.push({ task, priority });
        this.tasks.sort((a, b) => b.priority - a.priority);
    }

    update() {
        if (this.tasks.length === 0) return;

        const start = performance.now();
        while (this.tasks.length > 0) {
            const remaining = this.budgetMs - (performance.now() - start);
            if (remaining <= 0) break;

            const { task } = this.tasks.shift();
            try {
                task();
            } catch (e) {
                console.error('Task failed:', e);
            }
        }
    }
}
const taskQueue = new TaskQueue(6); // 6ms budget per frame
window.taskQueue = taskQueue;


// 模型列表 (动态获取)
let availableModels = [];
let currentModelIndex = 0;

// 初始化：获取模型列表并加载第一个
(async function init() {
    try {
        const res = await fetch('/api/models');
        const json = await res.json();
        if (json.code === 200 && json.data.length > 0) {
            availableModels = json.data;
            console.log('✅ 已获取模型列表:', availableModels);

            // 单模型场景优化：隐藏切换按钮
            if (availableModels.length <= 1) {
                const prevBtn = document.getElementById('prev-btn');
                const nextBtn = document.getElementById('next-btn');
                if (prevBtn) prevBtn.style.display = 'none';
                if (nextBtn) nextBtn.style.display = 'none';
            }

            // 加载第一个模型
            loadMainModel(0);
        } else {
            console.warn('⚠️ 未找到可用模型');
        }
    } catch (err) {
        console.error('❌ 初始化模型列表失败:', err);
    }
})();

// HTTP 轮询/POST 机制替代 WebSocket (Aligns with Paper's HTTP/2 multiplexing)
const API_URL = `${window.location.protocol}//${window.location.hostname}:3000/api/schedule`;

// 处理后端响应
async function handleServerResponse(res) {
    if (res.type === 'EDGE_RESPONSE') {
        // 更新Debug面板数据
        updateDebugPanel(res);

        // 处理预取指令 (MT-Web3DRC Active Prefetch)
        // 关键修复：仅当策略为 'mt-web3drc' 时才执行预取，避免与传统策略冲突
        const strategySelector = getEl('strategy-selector');
        const currentStrategy = strategySelector ? strategySelector.value : 'mt-web3drc';
        if (currentStrategy === 'mt-web3drc' && res.prefetchCmd && res.prefetchCmd.blockIds) {

            // 新增：预取策略限制
            // 1. 检查显存占用，超过 70% 暂停预取
            if (vramManager.limitMB > 0 && (vramManager.currentMB / vramManager.limitMB > 0.7)) {
                console.warn(`⏸️ [Prefetch] Paused due to high VRAM usage (${(vramManager.currentMB / vramManager.limitMB * 100).toFixed(1)}%)`);
                return;
            }

            console.log(`🚀 [Prefetch] 收到预取指令: ${res.prefetchCmd.reason}`, res.prefetchCmd.blockIds);

            // 2. 限制单次预取数量 (Max 3)
            const blocksToFetch = res.prefetchCmd.blockIds.slice(0, 3);
            if (blocksToFetch.length < res.prefetchCmd.blockIds.length) {
                console.log(`⚠️ [Prefetch] Limiting batch size to 3 (Original: ${res.prefetchCmd.blockIds.length})`);
            }

            // 遍历预取列表，主动发起请求
            blocksToFetch.forEach(blockId => {
                // 检查是否已加载或正在加载，避免重复
                if (!loadedBlocks.has(blockId) && !loadingBlocks.has(blockId)) {
                    const lod = res.prefetchCmd.lodLevel || 1;

                    // 发起后台请求 (Low Priority)
                    // 标记为正在加载
                    loadingBlocks.add(blockId);

                    const currentModelId = availableModels[currentModelIndex] ? availableModels[currentModelIndex].id : null;
                    const baseQuery = currentModelId ? `&baseModelId=${encodeURIComponent(currentModelId)}` : '';
                    // 添加时间戳防止浏览器缓存 API 响应
                    fetch(`/api/get-model-block?modelId=${encodeURIComponent(blockId)}&lodLevel=${lod}${baseQuery}&_t=${Date.now()}`)
                        .then(r => r.json())
                        .then(data => {
                            if (data.code === 200 && data.data.url) {
                                console.log(`[Prefetch] API returned URL for ${blockId}:`, data.data.url);
                                // 预取成功，加载到场景
                                loadGltfBlock(data.data.url, blockId, true, data.data.size || 0, lod); // true = isPrefetch
                            } else {
                                console.warn(`[Prefetch] API failed for ${blockId}:`, data);
                            }
                        })
                        .catch(e => console.warn('预取失败', e))
                        .finally(() => {
                            loadingBlocks.delete(blockId);
                        });
                }
            });
        }
    }
}

/**
 * 更新前端调试面板数据 (可视化论文指标)
 */
function updateDebugPanel(data) {
    const { fovFeature, scheduleResult, cacheStats } = data;
    const { deviceState } = data; // 如果后端回传了设备状态

    // 1. 网络与设备
    if (deviceState) {
        setText('net-type', deviceState.network);
        setText('net-downlink', deviceState.downlink + ' Mbps');
        setText('net-rtt', deviceState.rtt + ' ms');
        setText('cpu-cores', deviceState.concurrency);
    }

    // 2. 调度算法
    if (fovFeature && scheduleResult) {
        setText('fov-weight', fovFeature.centerWeight.toFixed(2));

        const R = scheduleResult.R.toFixed(2);
        const rEl = getEl('gain-r');
        if (rEl) {
            rEl.textContent = R;
            rEl.className = R > 5 ? 'value-high' : (R < 2 ? 'value-low' : 'value-med');
        }

        // 解析策略文本
        let strategy = '均衡';
        if (scheduleResult.lambda[1] > 0.7) strategy = '边缘侧重 (Edge-Heavy)';
        else if (scheduleResult.lambda[2] > 0.5) strategy = '终端侧重 (Client-Heavy)';
        setText('schedule-strategy', strategy);

        setText('rec-lod', 'LOD ' + scheduleResult.lodLevel);
    }

    // 3. 缓存与内存状态
    if (cacheStats) {
        setText('cache-hit', `${(cacheStats.hitRate * 100).toFixed(1)}% (${cacheStats.edgeStatus})`);
    }

    // 数据流向显示 (根据预取指令或最近的加载来源)
    // 这里简单根据预取指令判断
    const sourceEl = getEl('data-source');
    if (data.prefetchCmd && sourceEl) {
        if (data.prefetchCmd.type === 'PREFETCH') {
            sourceEl.textContent = 'Edge -> Client (Prefetch)';
            sourceEl.style.color = '#4caf50'; // Green
        }
    } else {
        // 如果没有预取，且正在运行，可能是回源
        // 实际应从 get-model-block 接口返回的 from 字段获取
        // 这里模拟 Idle
        // sourceEl.textContent = 'Idle';
        // sourceEl.style.color = '#aaa';
    }

    setText('client-mem', `${loadedBlocks.size} / 5`);

    // 计算可见块数 (简单统计)
    let visibleCount = 0;
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    loadedBlocks.forEach(group => {
        const box = new THREE.Box3().setFromObject(group);
        if (frustum.intersectsBox(box)) visibleCount++;
    });
    setText('visible-blocks', visibleCount);
    setText('sys-status', '运行中 (Running)');
}

// 模拟网络延迟
function simulateNetworkDelay(sizeMB = 2) {
    // Only simulate network delay during benchmark
    if (!window.benchmark || !window.benchmark.running) return;

    const netState = getSimulatedNetworkState();
    const bandwidthMbps = netState.downlink;
    const rttMs = netState.rtt;

    // 传输时间 = RTT + (Size * 8 / Bandwidth)
    const transferTimeMs = rttMs + (sizeMB * 8 / bandwidthMbps) * 1000;

    // 增加一点随机波动 (±10%)
    const jitter = transferTimeMs * (Math.random() * 0.2 - 0.1);
    let finalDelay = transferTimeMs + jitter;

    // --- 速度优化 ---
    // 为了加速测试流程（特别是针对大文件GLB），我们将模拟延迟除以一个系数
    // 默认加速 10 倍，且受 Benchmark 倍速控制
    const speedUpFactor = 10 * (window.benchmark ? window.benchmark.speedMultiplier : 1);
    finalDelay /= speedUpFactor;

    // --- 封顶限制 ---
    // 为了防止在 "Poor" 网络下大文件导致无限等待，设置最大延迟封顶 (例如 2秒)
    // 这样既保留了相对快慢，又不会让用户等太久
    const MAX_DELAY_MS = 2000;
    if (finalDelay > MAX_DELAY_MS) {
        // console.warn(`⚠️ Delay capped: ${finalDelay.toFixed(0)}ms -> ${MAX_DELAY_MS}ms`);
        finalDelay = MAX_DELAY_MS;
    }

    // Debug 0ms issue
    if (finalDelay < 10) {
        console.warn(`⚠️ Network delay too low: ${finalDelay.toFixed(2)}ms. State:`, netState);
    }

    return new Promise(resolve => setTimeout(resolve, finalDelay));
}

function createLoadingToast() {
    const toast = document.createElement('div');
    toast.id = 'loading-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '80px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.background = 'rgba(0,0,0,0.7)';
    toast.style.color = 'white';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '5px';
    toast.style.zIndex = '9999';
    toast.style.display = 'none';
    document.body.appendChild(toast);
    return toast;
}

/**
 * 模拟 CPU 负载 (主线程阻塞 - 优化为异步分块执行)
 * 用于模拟大模型解析、解码、上传 GPU 等操作对主线程的占用
 * @param {number} durationMs 阻塞时长 (毫秒)
 */
function simulateCPULoad(durationMs) {
    return new Promise(resolve => {
        if (durationMs <= 0) {
            resolve();
            return;
        }

        const start = performance.now();

        // 递归执行小块任务，避免长期阻塞主线程导致 VRAM 回收延迟
        const chunk = () => {
            const now = performance.now();
            if (now - start >= durationMs) {
                resolve();
                return;
            }

            // 每次阻塞 5ms (小于一帧 16ms)，然后让出控制权
            const chunkStart = performance.now();
            while (performance.now() - chunkStart < 5) {
                // Busy wait
            }

            // 调度下一个块
            setTimeout(chunk, 0);
        };

        chunk();
    });
}

/**
 * 加载单个GLTF分块并添加到场景
 * @param {string} modelUrl 分块模型的完整URL
 * @param {string} blockKey 分块标识（如：2_lod1）
 * @param {boolean} isPrefetch 是否为预取块
 * @param {number} serverReportedSize 服务端报告的文件/文件夹大小(Bytes)
 */
async function loadGltfBlock(modelUrl, blockKey, isPrefetch = false, serverReportedSize = 0, lodLevel = 1) {
    if (loadedBlocks.has(blockKey) || loadingBlocks.has(blockKey)) return;

    // 标记为正在加载
    loadingBlocks.add(blockKey);
    const startTime = performance.now();
    let loadedSuccessfully = false;
    let modelSizeMB = 0; // Will be updated after fetch

    // 1. Geometry Cache Check (Geometry Reuse)
    let baseModelKey = blockKey;
    const copyMatch = blockKey.match(/(.*)_copy_(-?\d+)_(-?\d+)$/);
    if (copyMatch) {
        baseModelKey = `${copyMatch[1]}_lod${lodLevel}`; // e.g. "100%_lod1"
    } else if (blockKey === 'main') {
        baseModelKey = `main_lod${lodLevel}`;
    }

    // Check Cache immediately to avoid network if possible
    if (geometryCache.has(baseModelKey)) {
        // Track as loading to ensure benchmark waits for it
        loadingBlocks.add(blockKey);

        // Enqueue cloning task to manage CPU budget
        taskQueue.enqueue(async () => {
            try {
                console.log(`🧠 [Cache] Hit geometry for ${baseModelKey}`);
                const cachedGroup = await geometryCache.get(baseModelKey);
                const group = cachedGroup.clone();
                // Inherit size
                const sizeMB = cachedGroup.userData.sizeMB || 0;

                // --- VRAM Simulation Check ---
                // For clones, textures are likely shared, so incremental cost is low
                const incrementalMB = vramManager.getIncrementalSize(group);

                if (!vramManager.checkLimit(incrementalMB)) {
                    checkMemoryLimit(incrementalMB);
                    // Re-check after potential unload
                    if (!vramManager.checkLimit(incrementalMB)) {
                        console.warn(`⚠️ [VRAM Limit] Refusing to load cached block ${blockKey}. Current: ${vramManager.currentMB.toFixed(1)}MB, Need: ${incrementalMB.toFixed(1)}MB, Limit: ${vramManager.limitMB}MB`);
                        loadingBlocks.delete(blockKey);
                        return;
                    }
                }
                vramManager.track(group);
                group.userData.vramSize = incrementalMB;
                group.userData.trackedByManager = true;
                // -----------------------------

                // Position logic
                if (blockKey.startsWith('grid_') || blockKey.match(/_copy_(-?\d+)_(-?\d+)$/)) {
                    let x = 0, z = 0;
                    if (copyMatch) {
                        x = parseInt(copyMatch[1]) * 50;
                        z = parseInt(copyMatch[2]) * 50;
                    } else {
                        const parts = blockKey.split('_');
                        if (parts.length >= 3) {
                            x = parseInt(parts[1]) * 50;
                            z = parseInt(parts[2]) * 50;
                        }
                    }
                    group.position.set(x, 0, z);
                    group.rotation.y = Math.random() * Math.PI * 2;
                }

                group.userData.isPrefetched = isPrefetch;
                group.userData.lodLevel = lodLevel;
                group.userData.sizeMB = sizeMB;

                // 模拟 CPU 负载 (Async)
                if (window.benchmark && window.benchmark.running) {
                    let cpuLoadFactor = 1.0;
                    const strategySelector = getEl('strategy-selector');
                    const currentStrategy = strategySelector ? strategySelector.value : 'mt-web3drc';
                    if (currentStrategy === 'mt-web3drc') cpuLoadFactor = 0.05;
                    const actualBlockTime = (sizeMB * 30 * cpuLoadFactor) / (10 * window.benchmark.speedMultiplier);
                    if (actualBlockTime > 2) {
                        await simulateCPULoad(actualBlockTime);
                    }
                }

                if (isPrefetch) {
                    const boxHelper = new THREE.BoxHelper(group, 0x00ff00);
                    group.add(boxHelper);
                } else {
                    group.position.set(0, 0, 0);
                    group.scale.set(1, 1, 1);
                    if (blockKey === 'main') {
                        fitCameraToObject(group);
                        cube.visible = false;
                    }
                }

                group.userData.loadTime = Date.now();
                scene.add(group);
                loadedBlocks.set(blockKey, group);

                if (window.benchmark && window.benchmark.running) {
                    const latency = performance.now() - startTime;
                    window.benchmark.recordLoad(blockKey, latency, isPrefetch, true, sizeMB);
                }
                checkMemoryLimit();
            } catch (e) {
                console.error("Cache clone failed", e);
            } finally {
                loadingBlocks.delete(blockKey);
            }
        }, 100); // High priority for cache hits
        return;
    }

    // Cache Miss - Fetch First (Async IO)
    (async () => {
        try {
            console.log(`🔄 开始加载模型块：${modelUrl}`);
            const loadingToast = document.getElementById('loading-toast') || createLoadingToast();
            loadingToast.style.display = 'block';
            loadingToast.textContent = `Downloading: ${blockKey}...`;

            let response;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    response = await fetch(modelUrl);
                    if (!response.ok) {
                        // 如果是 404，不要重试，直接抛出
                        if (response.status === 404) {
                            throw new Error(`404 Not Found: ${modelUrl}`);
                        }
                        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
                    }
                    break;
                } catch (e) {
                    console.warn(`⚠️ Attempt ${attempt} failed for ${blockId}: ${e.message}`);
                    if (e.message.includes('404')) throw e; // Don't retry 404
                    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
                }
            }
            if (!response) throw new Error(`Failed to load ${blockId} after 3 attempts`);

            loadingToast.style.display = 'none';
            const arrayBuffer = await response.arrayBuffer();

            if (serverReportedSize > 0) {
                modelSizeMB = serverReportedSize / (1024 * 1024);
            } else {
                modelSizeMB = arrayBuffer.byteLength / (1024 * 1024);
            }

            await simulateNetworkDelay(modelSizeMB);

            // Enqueue Parse Task (CPU Heavy)
            const priority = blockKey === 'main' ? 100 : (isPrefetch ? 10 : 50);

            taskQueue.enqueue(() => {
                const path = modelUrl.substring(0, modelUrl.lastIndexOf('/') + 1);

                // Parse is CPU heavy (for JSON) or Worker heavy (Draco)
                gltfLoader.parse(arrayBuffer, path, async (gltf) => {
                    const group = gltf.scene;
                    group.userData.sizeMB = modelSizeMB;

                    // --- VRAM Simulation Check ---
                    const incrementalMB = vramManager.getIncrementalSize(group);

                    if (!vramManager.checkLimit(incrementalMB)) {
                        checkMemoryLimit(incrementalMB);
                        if (!vramManager.checkLimit(incrementalMB)) {
                            console.warn(`⚠️ [VRAM Limit] Refusing to load new block ${blockKey}. Current: ${vramManager.currentMB.toFixed(1)}MB, Need: ${incrementalMB.toFixed(1)}MB, Limit: ${vramManager.limitMB}MB`);
                            loadingBlocks.delete(blockKey);
                            return;
                        }
                    }
                    vramManager.track(group);
                    group.userData.vramSize = incrementalMB;
                    group.userData.trackedByManager = true;
                    // -----------------------------

                    geometryCache.set(baseModelKey, Promise.resolve(group));

                    // ... CPU Load Simulation ...
                    let cpuLoadFactor = 1.0;
                    const strategySelector = getEl('strategy-selector');
                    const currentStrategy = window.benchmark && window.benchmark.running ? window.benchmark.strategy : (strategySelector ? strategySelector.value : 'mt-web3drc');
                    if (currentStrategy === 'mt-web3drc') cpuLoadFactor = 0.05;
                    const actualBlockTime = (modelSizeMB * 30 * cpuLoadFactor) / (10 * (window.benchmark ? window.benchmark.speedMultiplier : 1));
                    if (actualBlockTime > 2 && window.benchmark && window.benchmark.running) {
                        await simulateCPULoad(actualBlockTime);
                    }

                    // Position logic (Duplicate code - ideally refactor)
                    if (blockKey.startsWith('grid_') || blockKey.match(/_copy_(-?\d+)_(-?\d+)$/)) {
                        let x = 0, z = 0;
                        if (copyMatch) {
                            x = parseInt(copyMatch[1]) * 50;
                            z = parseInt(copyMatch[2]) * 50;
                        } else {
                            const parts = blockKey.split('_');
                            if (parts.length >= 3) {
                                x = parseInt(parts[1]) * 50;
                                z = parseInt(parts[2]) * 50;
                            }
                        }
                        group.position.set(x, 0, z);
                        group.rotation.y = Math.random() * Math.PI * 2;
                    }

                    group.userData.isPrefetched = isPrefetch;
                    group.userData.lodLevel = lodLevel;
                    group.userData.sizeMB = modelSizeMB;

                    if (isPrefetch) {
                        const boxHelper = new THREE.BoxHelper(group, 0x00ff00);
                        group.add(boxHelper);
                    } else {
                        group.position.set(0, 0, 0);
                        group.scale.set(1, 1, 1);
                        if (blockKey === 'main') {
                            fitCameraToObject(group);
                            cube.visible = false;
                        }
                    }

                    group.userData.loadTime = Date.now();
                    scene.add(group);
                    loadedBlocks.set(blockKey, group);
                    console.log(`✅ 模型块${blockKey}加载完成${isPrefetch ? ' (Prefetched)' : ''}`);

                    if (window.benchmark && window.benchmark.running) {
                        const latency = performance.now() - startTime;
                        window.benchmark.recordLoad(blockKey, latency, isPrefetch, true, modelSizeMB);
                    }
                    loadingBlocks.delete(blockKey);
                    checkMemoryLimit();
                    
                    // 在主模型加载完成后隐藏演示立方体
                    if (blockKey === 'main') {
                        cube.visible = false;
                    }
                }, (err) => {
                    console.warn(`⚠️ Parse failed for ${blockKey}:`, err);
                    createSimulatedBlock(blockKey);
                    loadingBlocks.delete(blockKey);
                    checkMemoryLimit();
                });
            }, priority);

        } catch (err) {
            console.warn(`⚠️ Fetch failed for ${blockKey}:`, err);
            createSimulatedBlock(blockKey);
            loadingBlocks.delete(blockKey);
            checkMemoryLimit();
        }
    })();

}

/**
 * 创建虚拟模型块 (用于演示 MTP 淘汰机制)
 */
function createSimulatedBlock(blockKey) {
    if (loadedBlocks.has(blockKey)) return;

    // 随机颜色
    const color = Math.random() * 0xffffff;
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshStandardMaterial({ color: color, wireframe: false });
    const mesh = new THREE.Mesh(geometry, material);

    // 随机位置 (分布在相机周围 10-30 单位处)
    // 确保有些在视锥体内，有些在视锥体外
    // 3. 改进：基于网格的空间预测 (Spatial Grid Prediction)
    // 尝试解析各种格式:
    // 1. "x_y_z" (old)
    // 2. "grid_x_z" (legacy)
    // 3. "ModelName_copy_x_z" (new)

    let x = 0, y = 0, z = 0;
    const parts = blockKey.split('_');

    // Check for new format: .*_copy_x_z
    const copyMatch = blockKey.match(/_copy_(-?\d+)_(-?\d+)$/);
    if (copyMatch) {
        x = parseInt(copyMatch[1]) * 50; // Grid Size 50 (matching checkVisibleGrids)
        y = 0;
        z = parseInt(copyMatch[2]) * 50;
    }
    else if (blockKey.startsWith('grid_')) {
        // grid_x_z
        // parts[1] is x, parts[2] is z
        x = parseInt(parts[1]) * 50;
        y = 0;
        z = parseInt(parts[2]) * 50;
    }
    else if (parts.length >= 3 && !isNaN(parseInt(parts[0]))) {
        // "1_-2_0"
        x = parseInt(parts[0]) * 5;
        y = parseInt(parts[1]) * 5;
        z = parseInt(parts[2]) * 5;
    } else {

        // 如果只是随机 ID，我们尽量让它出现在相机前方
        // 预测向量：相机位置 + 视线方向 * 距离
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        const predictPos = camera.position.clone().add(direction.multiplyScalar(20));

        // 加上随机偏移，模拟周围的块
        x = predictPos.x + (Math.random() - 0.5) * 20;
        y = predictPos.y + (Math.random() - 0.5) * 10;
        z = predictPos.z + (Math.random() - 0.5) * 20;
    }

    mesh.position.set(x, y, z);

    // 添加文字标签 (Block ID)
    // 简单起见，这里不加文字，只加 Mesh

    mesh.userData.lodLevel = stabilityConfig.maxLod;
    mesh.userData.sizeMB = currentModelSizeMB;

    // VRAM Sim
    const vramMB = 1.0; // 假设虚拟块占用 1MB
    if (!vramManager.checkLimit(vramMB)) {
        checkMemoryLimit(vramMB);
        if (!vramManager.checkLimit(vramMB)) {
            console.warn(`⚠️ [VRAM Limit] Refusing to create simulated block ${blockKey}. Current: ${vramManager.currentMB.toFixed(1)}MB, Need: ${vramMB.toFixed(1)}MB, Limit: ${vramManager.limitMB}MB`);
            return;
        }
    }
    vramManager.add(vramMB);
    mesh.userData.vramSize = vramMB;

    scene.add(mesh);
    loadedBlocks.set(blockKey, mesh);
    console.log(`🧩 [Simulated] 生成虚拟块: ${blockKey} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
}

/**
 * 统一内存检查入口
 * @param {number} requiredMB 需要腾出的空间 (MB)
 */
function checkMemoryLimit(requiredMB = 0) {
    const strategy = getCurrentStrategy();
    const maxBlocks = getMaxBlocksForStrategy(strategy);

    if (strategy === 'traditional') {
        manageMemoryTraditional(maxBlocks, requiredMB);
    } else if (strategy === 'seq-load') {
        manageMemorySeqLoad(maxBlocks, requiredMB);
    } else {
        manageMemoryWithVisualStack(maxBlocks, requiredMB);
    }
}

/**
 * 顺序加载策略 (Seq-Load - Baseline)
 * 模拟简单的 FIFO (First-In-First-Out) 队列，不考虑任何视觉或距离因素
 * 这种策略在论文中作为"最差情况"基线
 */
function manageMemorySeqLoad(maxBlocks = 5, requiredMB = 0) {
    // 1. Count-based eviction
    while (loadedBlocks.size > maxBlocks) {
        const keys = Array.from(loadedBlocks.keys());
        const removeKey = keys[0]; // Oldest
        unloadBlock(removeKey);
    }

    // 2. Memory-based eviction
    while (loadedBlocks.size > 0 && !vramManager.checkLimit(requiredMB)) {
        const keys = Array.from(loadedBlocks.keys());
        const removeKey = keys[0]; // Oldest
        console.warn(`⚠️ [Seq-Load] 内存不足 (${vramManager.currentMB.toFixed(1)}MB + ${requiredMB.toFixed(1)}MB > ${vramManager.limitMB}MB)，强制淘汰: ${removeKey}`);
        unloadBlock(removeKey);
    }
}

/**
 * 传统动态堆栈加载方法 (Traditional Stack / Std-LOD)
 * 仅基于距离进行剔除，不考虑视锥体可视性 (Frustum Culling)
 * 模拟简单的 FIFO 或 距离优先 策略
 * @param {number} maxBlocks 最大缓存分块数量
 * @param {number} requiredMB 需要腾出的空间 (MB)
 */
function manageMemoryTraditional(maxBlocks = 10, requiredMB = 0) {
    // 即使 count < maxBlocks，如果内存不足也需要清理
    if (loadedBlocks.size === 0) return;

    const blockScores = [];
    for (const [key, group] of loadedBlocks.entries()) {
        let score = 0;

        // 仅计算距离 (越近分数越高，保留)
        const box = new THREE.Box3().setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        const distanceToCam = center.distanceTo(camera.position);

        // 评分 = -距离 (距离越小，分数越大)
        score = -distanceToCam;

        blockScores.push({ key, score, group });
    }

    // 排序：分数从高到低保留 (即保留最近的)
    blockScores.sort((a, b) => b.score - a.score);

    // 1. Count check
    let keepCount = maxBlocks;

    // 2. Memory check (Iterative reduction)
    // 模拟：假设我们只保留 keepCount 个，计算是否够用？
    // 这里简化逻辑：先按 count 剔除，然后如果内存不够，继续剔除队尾

    let removeBlocks = [];

    // Phase 1: Count limit
    if (blockScores.length > maxBlocks) {
        removeBlocks = blockScores.slice(maxBlocks);
        blockScores.length = maxBlocks; // Truncate to kept blocks
    }

    // Phase 2: Memory limit
    // 注意：这里无法精确预知卸载后的剩余内存，因为 block 大小各异
    // 采用贪婪策略：只要内存不足，就从最低分开始剔除
    while (blockScores.length > 0 && !vramManager.checkLimit(requiredMB)) {
        // 既然 blockScores 是保留的（高分在前），那么最低分是最后一个
        const victim = blockScores.pop();
        removeBlocks.push(victim);

        // 估算移除该块后的释放量（为了循环条件能终止，我们必须假设它能释放空间）
        // 实际上 unloadBlock 是异步的，但 vramManager.checkLimit 依赖 currentMB
        // 我们需要临时“借用”一下 victim 的大小来判断循环
        // 但由于 unloadBlock 会立即更新 vramManager (在 index.js:518)，所以这里如果是同步循环调用 unloadBlock 是可行的
        // 前提是 unloadBlock 必须同步更新 vramManager.currentMB

        // 让我们确认 unloadBlock 的逻辑：
        // vramManager.untrack(group) -> this.currentMB -= ... -> updateDisplay()
        // 是同步的！

        unloadBlock(victim.key); // 立即执行 VRAM 更新
        console.warn(`⚠️ [Traditional] 内存不足，强制淘汰: ${victim.key} (Score: ${victim.score.toFixed(1)})`);
    }

    // 执行 Phase 1 的移除 (Phase 2 的已经在循环中移除了)
    // 但要注意：Phase 2 中 blockScores 被修改了，removeBlocks 包含了 Phase 1 切出来的和 Phase 2 pop 出来的
    // 实际上 Phase 1 的切片在 blockScores.length = maxBlocks 时已经分离
    // 我们需要把 Phase 1 的也 unload

    // 修正逻辑：
    // 上面的 while 循环直接 unload 了 Phase 2 的 victim。
    // Phase 1 的 removeBlocks 还没 unload。
    // 但为了安全，检查一下 loadedBlocks
    removeBlocks.forEach(item => {
        // 避免重复 unload (如果 Phase 2 逻辑有重叠，虽然后面 blockScores.length截断了应该没事)
        // 但为了安全，检查一下 loadedBlocks
        if (loadedBlocks.has(item.key)) {
            unloadBlock(item.key);
            // 降低刷屏频率
            if (Math.random() < 0.1) {
                console.log(`🗑️ [Traditional] 动态淘汰: ${item.key} (Score: ${item.score.toFixed(1)})`);
            }
        }
    });
}

/**
 * 论文核心：基于视觉注意力的堆栈内存管理 (Visual-Associated Stack Management)
 * 优先保留视锥体(Frustum)内的模型块，淘汰视场外且LOD低的分块
 * @param {number} maxBlocks 最大缓存分块数量
 * @param {number} requiredMB 需要腾出的空间 (MB)
 */
function manageMemoryWithVisualStack(maxBlocks = 10, requiredMB = 0) {
    if (loadedBlocks.size === 0) return;

    // 1. 计算当前视锥体
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    // 2. 为每个块计算“视觉评分”
    const blockScores = [];
    const now = Date.now();

    for (const [key, group] of loadedBlocks.entries()) {
        let score = 0;

        // 因子A: 可见性 (权重最高)
        // 简单检测：包围盒是否与视锥体相交
        const box = new THREE.Box3().setFromObject(group);
        const isVisible = frustum.intersectsBox(box);
        if (isVisible) {
            score += 1000; // 视场内极大加权

            // 因子B: 视场中心距离 (可选优化)
            const center = box.getCenter(new THREE.Vector3());
            const distanceToCam = center.distanceTo(camera.position);
            score -= distanceToCam; // 越近分越高(减去距离)
        } else {
            // 视场外：仅保留最近加载的(时间局部性)
            // 增加对预取块的保护：如果刚加载不久，给予较高分数
            const loadTime = group.userData.loadTime || 0;
            const timeSinceLoad = now - loadTime;

            if (timeSinceLoad < 5000) { // 5秒内加载的块保护
                score += 500;
                if (group.userData.isPrefetched) {
                    score += 200; // 预取块额外加分
                }
            } else {
                score -= timeSinceLoad / 1000; // 越久未被看到分越低
            }
        }

        blockScores.push({ key, score, group });
    }

    // 3. 排序：分数从高到低保留，低的淘汰
    blockScores.sort((a, b) => b.score - a.score);

    // 4. 淘汰逻辑 (Count + Memory)
    let removeBlocks = [];

    // Phase 1: Count Limit
    if (blockScores.length > maxBlocks) {
        removeBlocks = blockScores.slice(maxBlocks);
        blockScores.length = maxBlocks; // Truncate
    }

    // Phase 2: Memory Limit
    while (blockScores.length > 0 && !vramManager.checkLimit(requiredMB)) {
        const victim = blockScores.pop(); // Remove lowest score from kept blocks
        // 立即卸载以释放内存
        unloadBlock(victim.key);
        console.warn(`⚠️ [MT-Web3DRC] 内存不足，强制淘汰: ${victim.key} (Score: ${victim.score.toFixed(1)})`);
    }

    // Unload Phase 1 blocks
    removeBlocks.forEach(item => {
        if (loadedBlocks.has(item.key)) {
            unloadBlock(item.key);
            // 仅在首次淘汰时打印，避免刷屏
            if (Math.random() < 0.1) {
                console.log(`🗑️ [MT-Web3DRC] 动态淘汰: ${item.key} (Score: ${item.score.toFixed(1)})`);
            }
        }
    });
}

/**
 * 卸载未使用的模型分块（释放内存）- 旧版保留兼容，建议调用新版
 */
function unloadUnusedBlocks(keepCount) {
    manageMemoryWithVisualStack(keepCount);
}

function fitCameraToObject(object3D) {
    const box = new THREE.Box3().setFromObject(object3D);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    object3D.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = (maxDim / 2) / Math.tan(fov / 2);
    camera.position.set(0, 0, distance * 1.3);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);
}


// Network Simulator Logic
const networkSelector = getEl('network-selector');
const customNetworkDiv = getEl('custom-network');
const customBwInput = getEl('custom-bw');
const customRttInput = getEl('custom-rtt');

if (networkSelector) {
    networkSelector.addEventListener('change', (e) => {
        if (customNetworkDiv) {
            if (e.target.value === 'custom') {
                customNetworkDiv.style.display = 'block';
            } else {
                customNetworkDiv.style.display = 'none';
            }
        }
    });
}

function getSimulatedNetworkState() {
    const type = networkSelector ? networkSelector.value : 'wifi';
    let downlink = 10;
    let rtt = 50;

    switch (type) {
        case '4g':
            downlink = 10;
            rtt = 50;
            break;
        case '5g':
            downlink = 100;
            rtt = 10;
            break;
        case 'wifi':
            downlink = 300;
            rtt = 5;
            break;
        case 'poor':
            downlink = 1;
            rtt = 200;
            break;
        case 'custom':
            downlink = customBwInput ? (parseFloat(customBwInput.value) || 10) : 10;
            rtt = customRttInput ? (parseFloat(customRttInput.value) || 50) : 50;
            break;
    }

    return { downlink, rtt, type };
}

let lastTime = 0;
const fpsLimit = 60;
const interval = 1000 / fpsLimit;
// 监听 VSync 切换及 FPS 控制
function initRenderControls() {
    // VSync Selector
    const vsyncSelector = getEl('vsync-selector');
    if (vsyncSelector) {
        console.log('✅ Render controls found, initializing...');
        vsyncSelector.addEventListener('change', (e) => {
            const newVal = e.target.value === 'off';
            if (isVsyncOff !== newVal) {
                isVsyncOff = newVal;
                console.log(`🔄 VSync changed to: ${isVsyncOff ? 'OFF' : 'ON'}`);
                // 重启循环以应用更改
                if (animationId) cancelAnimationFrame(animationId);
                if (timeoutId) clearTimeout(timeoutId);
                renderLoop();
            }
        });
        // Sync initial state
        isVsyncOff = vsyncSelector.value === 'off';
    } else {
        console.warn('⚠️ Render controls not found, retrying in 1s...');
        setTimeout(initRenderControls, 1000);
        return;
    }

    // FPS Limit Checkbox
    const fpsEnabled = getEl('fps-limit-enabled');
    if (fpsEnabled) {
        fpsEnabled.addEventListener('change', (e) => {
            fpsManager.enabled = e.target.checked;
            console.log(`🎮 FPS Limit: ${fpsManager.enabled}`);
        });
        fpsManager.enabled = fpsEnabled.checked;
    }

    // FPS Target Input
    const fpsTarget = getEl('fps-limit-target');
    if (fpsTarget) {
        fpsTarget.addEventListener('change', (e) => {
            const fps = parseInt(e.target.value) || 60;
            fpsManager.setTargetFPS(fps);
            console.log(`🎮 Target FPS: ${fps}`);
        });
        fpsManager.setTargetFPS(parseInt(fpsTarget.value) || 60);
    }

    // Load Simulation
    const loadMode = getEl('load-mode-selector');
    const customLoadRow = getEl('custom-load-row');
    const customLoadMs = getEl('custom-load-ms');

    if (loadMode) {
        loadMode.addEventListener('change', (e) => {
            fpsManager.loadMode = e.target.value;
            if (customLoadRow) {
                if (e.target.value === 'custom') {
                    customLoadRow.style.display = 'flex';
                } else {
                    customLoadRow.style.display = 'none';
                }
            }
            console.log(`🏋️ Load Mode: ${fpsManager.loadMode}`);
        });
        // Initial state
        fpsManager.loadMode = loadMode.value;
        if (fpsManager.loadMode === 'custom' && customLoadRow) customLoadRow.style.display = 'flex';
    }

    if (customLoadMs) {
        customLoadMs.addEventListener('change', (e) => {
            fpsManager.customLoadMs = parseInt(e.target.value) || 0;
            console.log(`🏋️ Custom Load: ${fpsManager.customLoadMs}ms`);
        });
        fpsManager.customLoadMs = parseInt(customLoadMs.value) || 0;
    }

    // Max Triangles Input
    const maxTrisInput = getEl('max-triangles-input');
    if (maxTrisInput) {
        maxTrisInput.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val > 0) {
                stabilityConfig.maxTriangles = val * 1000000;
                console.log(`🔺 Max Triangles set to: ${stabilityConfig.maxTriangles}`);
            }
        });
        // Initial value
        const val = parseFloat(maxTrisInput.value);
        if (!isNaN(val) && val > 0) {
            stabilityConfig.maxTriangles = val * 1000000;
        }
    }

    // --- GPU Simulator Controls ---
    const gpuSim = new GPUSimulator(renderer, scene, camera);
    window.gpuSim = gpuSim; // Expose for debug

    // Shader Stress
    const shaderInput = getEl('shader-stress-input');
    const shaderVal = getEl('shader-stress-val');
    if (shaderInput) {
        shaderInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            gpuSim.setStressLevel(val);
            if (shaderVal) shaderVal.textContent = val;
        });
    }

    // Resolution Scale
    const resSelector = getEl('resolution-selector');
    if (resSelector) {
        resSelector.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            gpuSim.setResolutionScale(1.0 / val); // User selects 2.0x (means high quality? Or 2x pixel count?)
            // Usually 2.0x means double density (High DPI).
            // User request: "renderer.setPixelRatio(window.devicePixelRatio * 2)"
            // So logic:
            gpuSim.setResolutionScale(val);
        });
    }

    // VRAM Limit
    const vramInput = getEl('vram-limit-input');
    if (vramInput) {
        vramInput.addEventListener('change', (e) => {
            const val = parseInt(e.target.value);
            if (val > 0) {
                vramManager.limitMB = val;
                vramManager.updateDisplay();
            }
        });
        vramManager.limitMB = parseInt(vramInput.value) || 1024;
        vramManager.updateDisplay();
    }
}

// Start listener init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRenderControls);
} else {
    initRenderControls();
}

let animationId = null;
let timeoutId = null;

function renderLoop() {
    const now = performance.now();

    if (isVsyncOff) {
        // VSync OFF: Control timing with setTimeout to cap FPS
        // 1. Load Simulation
        fpsManager.simulateLoad();

        fpsManager.updateLastFrameTime(now);
        animate(now); // Render

        // Calculate delay for next frame
        const delay = fpsManager.getNextFrameDelay(performance.now());
        timeoutId = setTimeout(renderLoop, delay);
    } else {
        // VSync ON: rAF
        animationId = requestAnimationFrame(renderLoop);

        if (fpsManager.shouldRender(now)) {
            // 1. Load Simulation
            fpsManager.simulateLoad();

            fpsManager.updateLastFrameTime(now);
            animate(now);
        }
    }
}

// 修改帧时间计算，使用更准确的方法
function animate(time) {
    // requestAnimationFrame(animate); // 移除旧的递归

    // 确保 time 存在 (首次调用可能为 undefined)
    if (!time) time = performance.now();

    // 使用 requestAnimationFrame 提供的时间戳计算帧时间差
    // 这样可以正确反映实际的帧间隔时间，包括 VSync 等待时间
    let frameTime = 0;
    if (lastTime > 0) {
        frameTime = time - lastTime;
    }
    lastTime = time;

    // 算法：基于当前帧与上一帧的时间间隔(ms)计算瞬时帧率
    // Algorithm: Calculate instantaneous FPS based on the interval (ms) between frames
    let fps = 0;
    if (frameTime > 0) {
        fps = 1000 / frameTime;
    }

    // --- UI Update (New) ---
    // Update FPS Display every 10 frames
    if (renderer.info.render.frame % 10 === 0) {
        const fpsEl = document.getElementById('real-fps');
        if (fpsEl) {
            fpsEl.textContent = fps.toFixed(1);
            if (fps < fpsManager.targetFPS * 0.9) fpsEl.style.color = '#ff5555'; // Red
            else fpsEl.style.color = '#4caf50'; // Green
        }
    }

    // Anomaly Detection (Skip first 60 frames)
    if (renderer.info.render.frame > 60 && fpsManager.enabled) {
        if (fps < fpsManager.targetFPS * 0.8) { // Drop below 80% target
            fpsManager.recordAnomaly(fps);
            const dropEl = document.getElementById('fps-drop-count');
            if (dropEl) {
                dropEl.textContent = `(${fpsManager.totalAnomalies} drops)`;
                dropEl.style.display = 'inline';
            }
        }
    }
    // -----------------------

    stats.begin(); // Stats 开始监测

    // --- 高精度性能计时 ---
    const frameStart = performance.now();

    // 修复：只在没有主模型且没有其他模型块时旋转演示立方体
    const hasMainModel = loadedBlocks.has('main');
    const hasOtherModels = Array.from(loadedBlocks.keys()).some(key => key !== 'main');
    
    if (!hasMainModel && !hasOtherModels) {
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;
        cube.visible = true; // 确保演示立方体在无模型时可见
    } else {
        cube.visible = false; // 有任何模型时隐藏演示立方体
    }


    const cameraData = {
        fov: camera.fov,
        aspect: camera.aspect,
        position: [camera.position.x, camera.position.y, camera.position.z],
        rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z]
    };

    if (renderer.info.render.frame % 30 === 0) { // 每30帧上报一次，模拟 0.5秒/次的控制频率
        // 获取模拟的网络状态
        const simNetwork = getSimulatedNetworkState();

        const currentDeviceState = {
            network: simNetwork.type, // 使用模拟类型
            rtt: simNetwork.rtt,
            downlink: simNetwork.downlink,
            concurrency: navigator.hardwareConcurrency || 4,
            battery: 100
        };

        // HTTP POST 上报
        const currentModelId = availableModels[currentModelIndex] ? availableModels[currentModelIndex].id : null;
        fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cameraData, deviceState: currentDeviceState, currentModelId })
        })
            .then(res => res.json())
            .then(data => handleServerResponse(data))
            .catch(err => console.warn('调度请求失败:', err));
    }

    renderer.render(scene, camera);
    controls.update(); // 必须在动画循环中更新控制器

    const frameEnd = performance.now();
    const actualFrameTime = frameEnd - frameStart; // Pure CPU/GPU submission time (not including VSync wait)

    // 记录 FPS 和 纯渲染耗时 到 Benchmark
    // Record both FPS (Smoothness) and Pure Processing Time (Performance Load)
    if (window.benchmark && window.benchmark.running) {
        // 使用用户视觉的FPS进行记录
        if (fps > 0 && fps < 200) {  // 合理的FPS范围
            window.benchmark.recordFPS(fps, actualFrameTime);
        } else if (fps >= 200) {
            // 记录异常高的 FPS 值用于调试
            console.warn(`异常 FPS 值: ${fps.toFixed(2)}, 帧时间: ${actualFrameTime.toFixed(2)}ms`);
        }
    }

    let memoryUsedMB = 0;
    if (performance.memory) {
        memoryUsedMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    }
    
    // 使用用户视觉的FPS进行稳定性监控
    if (fps > 0 && fps < 200) {
        stabilityMonitor.record({ fps, frameTime: actualFrameTime, memoryMB: memoryUsedMB });
    } else if (fps >= 200) {
        // 记录异常值但不纳入统计
        console.debug(`跳过异常 FPS 值: ${fps.toFixed(2)}`);
    }
    if (renderer.info.render.frame % 20 === 0) {
        updateStabilityPolicy();
        updateProxyInstances();
    }

    // --- Task Queue Update ---
    if (window.taskQueue) {
        window.taskQueue.update();
    }

    // Update Frame Time UI
    const frameTimeEl = document.getElementById('frame-time');
    if (frameTimeEl) {
        frameTimeEl.textContent = actualFrameTime.toFixed(2) + ' ms';
        if (isVsyncOff) {
            const fps = 1000 / Math.max(actualFrameTime, 0.1);
            frameTimeEl.textContent += ` (~${fps.toFixed(0)} FPS)`;
        }
    }

    // 实时内存检测 (每 30 帧检测一次，模拟动态淘汰)
    if (renderer.info.render.frame % 30 === 0) {
        checkMemoryLimit();
    }

    stats.end(); // Stats 结束监测
}

// 启动渲染循环
renderLoop();
// animate(); // Old entry point

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

function getCurrentStrategy() {
    const selector = document.getElementById('strategy-selector');
    return selector ? selector.value : 'mt-web3drc';
}

function getMaxBlocksForStrategy(strategy) {
    if (stabilityState.maxBlocksOverride !== null) return stabilityState.maxBlocksOverride;
    if (currentModelScale === 'large') return Math.max(3, stabilityConfig.baseMaxBlocks - 2);
    if (currentModelScale === 'small') return stabilityConfig.baseMaxBlocks + 2;
    return stabilityConfig.baseMaxBlocks;
}

function getDistanceLod(distance) {
    if (distance > 200) return 3;
    if (distance > 120) return 2;
    return 1;
}

function selectLodLevel(sizeMB, distance, strategy) {
    // 关闭自适应：LOD 仅基于距离决定，不再根据模型大小或策略动态调整
    let lod = getDistanceLod(distance);
    return Math.min(stabilityConfig.maxLod, Math.max(stabilityConfig.minLod, lod));
}

function updateStabilityPolicy() {
    // 稳定策略已关闭：保留函数占位，避免调用端报错
    return;
}

function ensureProxyMesh(capacity) {
    if (proxyMesh && proxyCapacity >= capacity) return;
    if (proxyMesh) {
        scene.remove(proxyMesh);
        proxyMesh.geometry.dispose();
        proxyMesh.material.dispose();
        proxyMesh = null;
        proxyCapacity = 0;
        proxyIndexMap.clear();
    }
    proxyCapacity = Math.max(20, capacity);
    const proxyGeometry = new THREE.BoxGeometry(2, 2, 2);
    const proxyMaterial = new THREE.MeshStandardMaterial({ color: 0x3fa9f5 });
    proxyMesh = new THREE.InstancedMesh(proxyGeometry, proxyMaterial, proxyCapacity);
    proxyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(proxyMesh);
}

function updateProxyInstances() {
    if (currentModelScale !== 'large') {
        if (proxyMesh) proxyMesh.visible = false;
        loadedBlocks.forEach(group => {
            group.visible = true;
        });
        return;
    }
    const blocks = Array.from(loadedBlocks.entries());
    if (blocks.length === 0) return;
    ensureProxyMesh(blocks.length);
    if (proxyMesh) proxyMesh.visible = true;
    let index = 0;
    const tmpMatrix = new THREE.Matrix4();
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);
    const camPos = camera.position.clone();
    const proxyDistance = stabilityState.proxyDistance;
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    blocks.forEach(([key, group]) => {
        const box = new THREE.Box3().setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        const distance = center.distanceTo(camPos);
        const dirTo = center.clone().sub(camPos).normalize();
        const dot = direction.dot(dirTo);
        const inFrustum = frustum.intersectsBox(box);
        const useProxy = (distance > proxyDistance || dot < 0) && inFrustum;
        if (!inFrustum) {
            group.visible = false;
            return;
        }
        if (useProxy) {
            group.visible = false;
            tmpMatrix.makeTranslation(center.x, center.y, center.z);
            proxyMesh.setMatrixAt(index, tmpMatrix);
            proxyIndexMap.set(key, index);
            index += 1;
        } else {
            group.visible = true;
        }
    });
    proxyMesh.count = index;
    proxyMesh.instanceMatrix.needsUpdate = true;
}

async function loadMainModel(modelIndex) {
    if (modelIndex < 0 || modelIndex >= availableModels.length) return;

    // 1. 清理当前场景
    clearScene();

    // 2. 更新UI
    const modelInfo = availableModels[modelIndex];
    if (!modelInfo) return;
    setText('model-name', modelInfo.name);
    setText('model-count', `${modelIndex + 1} / ${availableModels.length}`);

    console.log(`🔄 切换模型: ${modelInfo.name} (${modelInfo.id})`);

    try {
        const cachedSize = modelSizeCache.get(modelInfo.id) || 0;
        const initialLod = selectLodLevel(cachedSize, 0, getCurrentStrategy());
        const res = await fetch(`/api/get-model-block?modelId=${encodeURIComponent(modelInfo.id)}&lodLevel=${initialLod}`);
        const data = await res.json();

        // 更新数据流向面板
        const sourceEl = getEl('data-source');
        if (sourceEl) {
            if (data.from === 'cloud-fetch') {
                sourceEl.textContent = 'Cloud -> Edge -> Client';
                sourceEl.style.color = '#ff9800'; // Orange
            } else if (data.from === 'disk-cache') {
                sourceEl.textContent = 'Edge Disk -> Client';
                sourceEl.style.color = '#2196f3'; // Blue
            } else if (data.from === 'memory-tree') {
                sourceEl.textContent = 'Edge Memory -> Client';
                sourceEl.style.color = '#00bcd4'; // Cyan
            }
        }

        if (!data || !data.data || !data.data.url) {
            throw new Error('模型缓存接口返回异常');
        }
        currentModelSizeMB = data.data.size || 0;
        currentModelScale = getModelScale(currentModelSizeMB);
        modelSizeCache.set(modelInfo.id, currentModelSizeMB);
        stabilityState = { lodBias: 0, maxBlocksOverride: null, proxyDistance: 140 };
        await loadGltfBlock(data.data.url, 'main', false, data.data.size || 0, initialLod);
    } catch (err) {
        console.error('❌ 加载主模型失败：', err);
        // 不弹alert干扰，仅控制台报错
    }
}

function clearScene() {
    console.log('🧹 Clearing scene...');

    // 1. 移除所有已加载的模型块 (使用 unloadBlock 复用逻辑)
    // 注意：unloadBlock 会从 loadedBlocks 中删除 key，所以需要先复制 keys
    Array.from(loadedBlocks.keys()).forEach(key => {
        // 这里的 unloadBlock 是异步 dispose，但在 Benchmark 重置阶段这通常是可以接受的
        // 关键是 vramManager.untrack 会同步执行，释放引用计数
        unloadBlock(key);
    });

    // 2. 确保 loadedBlocks 清空 (unloadBlock 已处理，但双保险)
    loadedBlocks.clear();

    // 3. 清空正在加载的队列
    loadingBlocks.clear();

    // 4. 清空几何体缓存 (Benchmark 每一轮应该是独立的，避免引用计数混乱)
    // 如果不清空，vramManager.reset() 后缓存里的 geometry 再次被使用时会重新 track，计数正确
    // 但如果 unloadBlock 已经 dispose 了 geometry，缓存里的就坏了
    // 所以必须清空缓存！
    geometryCache.clear();

    // 5. 重置 VRAM 管理器状态 (彻底消除累积误差)
    vramManager.reset();

    // 6. 其他清理
    cube.visible = true; // 显示加载占位符

    // 重置相机位置 (可选)
    // camera.position.set(0, 0, 10);
    // controls.reset();
}

// 绑定按钮事件
const prevBtn = getEl('prev-btn');
if (prevBtn) {
    prevBtn.addEventListener('click', () => {
        currentModelIndex = (currentModelIndex - 1 + availableModels.length) % availableModels.length;
        loadMainModel(currentModelIndex);
    });
}

const nextBtn = getEl('next-btn');
if (nextBtn) {
    nextBtn.addEventListener('click', () => {
        currentModelIndex = (currentModelIndex + 1) % availableModels.length;
        loadMainModel(currentModelIndex);
    });
}

/**
 * 基准测试系统 (Benchmark System)
 * 自动运行 Standard 和 MT-Web3DRC 策略，对比加载延迟
 */
class BenchmarkSystem {
    constructor() {
        this.running = false;
        this.strategy = '';
        this.results = {
            'seq-load': { loads: [], total: 0, avg: 0, fps: { min: Infinity, max: 0, avg: 0, stdDev: 0, samples: [] }, modelStats: [] },
            'traditional': { loads: [], total: 0, avg: 0, fps: { min: Infinity, max: 0, avg: 0, stdDev: 0, samples: [] }, modelStats: [] },
            'mt-web3drc': { loads: [], total: 0, avg: 0, fps: { min: Infinity, max: 0, avg: 0, stdDev: 0, samples: [] }, modelStats: [] }
        };
        this.cameraStartPos = new THREE.Vector3(0, 5, 50);
        this.cameraEndPos = new THREE.Vector3(0, 5, -150);
        this.speedMultiplier = 1.0;
        // 添加FPS统计数组
        this.fpsSamples = [];
    }

    setSpeed(multiplier) {
        this.speedMultiplier = multiplier;
        console.log(`⏩ Benchmark Speed set to ${multiplier}x`);
    }

    async runSuite() {
        if (this.running) return;
        this.running = true;
    // 1. 仅针对当前模型进行多轮测试
    const rounds = parseInt(prompt("Benchmark Rounds (e.g. 3):", "3")) || 3;

    console.log(`🚀 Starting Benchmark Suite for current model only (${rounds} rounds)...`);

    this.multiRoundResults = {
      'seq-load': [],
      'traditional': [],
      'mt-web3drc': []
    };

    // 固定只测试当前模型；若索引非法则回退到 0
    let targetIndex = currentModelIndex;
    if (targetIndex < 0 || targetIndex >= availableModels.length) {
      targetIndex = 0;
    }
    const modelIndices = [targetIndex];
    const modelCount = modelIndices.length;

        for (let r = 1; r <= rounds; r++) {
            console.log(`\n=== Round ${r} / ${rounds} ===`);

            for (const modelIndex of modelIndices) {
                currentModelIndex = modelIndex;
                const modelInfo = availableModels[modelIndex];
                console.log(`\n=== Model ${modelIndex + 1}/${modelCount}: ${modelInfo ? modelInfo.name : modelIndex} ===`);

                const seqResult = await this.runRound('seq-load', modelIndex, r);
                this.multiRoundResults['seq-load'].push(seqResult);
                await new Promise(res => setTimeout(res, 500));

                const stdResult = await this.runRound('traditional', modelIndex, r);
                this.multiRoundResults['traditional'].push(stdResult);
                await new Promise(res => setTimeout(res, 500));

                const mtResult = await this.runRound('mt-web3drc', modelIndex, r);
                this.multiRoundResults['mt-web3drc'].push(mtResult);
                await new Promise(res => setTimeout(res, 500));
            }
        }

        this.running = false;
        this.showMultiRoundReport(rounds);
    }

    showMultiRoundReport(rounds) {
        // Aggregate Results
        const aggregate = (strategy) => {
            const results = this.multiRoundResults[strategy];
            const sampleCount = results.length || 1;

            // 1. Latency Stats
            const latencies = results.map(r => r.avg);
            const avgLatency = latencies.reduce((a, b) => a + b, 0) / sampleCount;

            // Collect all raw latencies
            const allLatencies = results.flatMap(r => r.loads);

            // 2. FPS Stats (Re-calculate from all samples for accuracy)
            const allFpsSamples = results.flatMap(r => r.fps.samples);
            let fpsStats = { min: 0, max: 0, avg: 0, stdDev: 0, samples: [], boxplot: null, stable: 0 };

            if (allFpsSamples.length > 0) {
                const totalFps = allFpsSamples.reduce((a, b) => a + b, 0);
                const avgFps = totalFps / allFpsSamples.length;
                const minFps = Math.min(...allFpsSamples);
                const maxFps = Math.max(...allFpsSamples);
                const sorted = [...allFpsSamples].sort((a, b) => a - b);

                // StdDev
                const squareDiffs = allFpsSamples.map(value => Math.pow(value - avgFps, 2));
                const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / allFpsSamples.length;
                const stdDev = Math.sqrt(avgSquareDiff);
                const low1 = sorted[Math.max(0, Math.floor(sorted.length * 0.01))];
                const low5 = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
                const cv = avgFps > 0 ? stdDev / avgFps : 0;
                const rangePct = avgFps > 0 ? ((maxFps - minFps) / avgFps) * 100 : 0;

                fpsStats = {
                    min: minFps,
                    max: maxFps,
                    avg: avgFps,
                    stdDev: stdDev,
                    samples: allFpsSamples,
                    low1: low1,
                    low5: low5,
                    cv: cv,
                    rangePct: rangePct,
                    boxplot: computeBoxPlot(allFpsSamples)
                };

                // 使用 boxplot 提取中位数，作为稳定帧率
                fpsStats.stable = fpsStats.boxplot.median;
            }

            // 3. Frame Time (Internal)
            const frameTimes = results.map(r => (r.fpsInternal && r.fpsInternal.avgFrameTime) || 0);
            const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / sampleCount;

            // 4. Model Stats
            const allModelStats = results.flatMap(r => r.modelStats);
            const allModelRuns = results.map(r => r.modelInfo).filter(Boolean);

            return {
                avgLatency,
                avgFrameTime,
                fps: fpsStats,
                loads: allLatencies,
                modelStats: allModelStats,
                modelRuns: allModelRuns
            };
        };

        const seq = aggregate('seq-load');
        const std = aggregate('traditional');
        const mt = aggregate('mt-web3drc');

        // Statistical Significance
        // Compare MT vs Std
        let improvement = 0;
        if (std.avgLatency > 0) {
            improvement = ((std.avgLatency - mt.avgLatency) / std.avgLatency * 100);
        }

        const netState = getSimulatedNetworkState();

        const buildModelSummary = (results) => {
            const map = new Map();
            results.forEach(r => {
                if (!r || !r.modelInfo) return;
                const key = r.modelInfo.id || 'unknown';
                if (!map.has(key)) {
                    map.set(key, {
                        id: r.modelInfo.id,
                        name: r.modelInfo.name,
                        sizeMB: r.modelInfo.sizeMB,
                        scale: r.modelInfo.scale,
                        fpsAverages: []
                    });
                }
                map.get(key).fpsAverages.push(r.fps.avg || 0);
            });
            return Array.from(map.values()).map(m => ({
                ...m,
                avgFps: m.fpsAverages.reduce((a, b) => a + b, 0) / m.fpsAverages.length
            })).sort((a, b) => (a.sizeMB || 0) - (b.sizeMB || 0));
        };

        const seqModels = buildModelSummary(this.multiRoundResults['seq-load']);
        const stdModels = buildModelSummary(this.multiRoundResults['traditional']);
        const mtModels = buildModelSummary(this.multiRoundResults['mt-web3drc']);

        const mtRuns = this.multiRoundResults['mt-web3drc'];
        const smallStdSamples = mtRuns.filter(r => r.modelInfo && r.modelInfo.scale === 'small').map(r => r.fps.stdDev || 0);
        const largeStdSamples = mtRuns.filter(r => r.modelInfo && r.modelInfo.scale === 'large').map(r => r.fps.stdDev || 0);
        const avgSmallStd = smallStdSamples.length ? smallStdSamples.reduce((a, b) => a + b, 0) / smallStdSamples.length : 0;
        const avgLargeStd = largeStdSamples.length ? largeStdSamples.reduce((a, b) => a + b, 0) / largeStdSamples.length : 0;

        const advantageByModel = mtModels.map(m => {
            const stdMatch = stdModels.find(s => s.id === m.id);
            const seqMatch = seqModels.find(s => s.id === m.id);
            const competitor = [stdMatch, seqMatch].filter(Boolean).sort((a, b) => b.avgFps - a.avgFps)[0];
            const bestFps = competitor ? competitor.avgFps : 0;
            const advantage = bestFps > 0 ? ((m.avgFps - bestFps) / bestFps) * 100 : 0;
            return { id: m.id, name: m.name, sizeMB: m.sizeMB, advantage };
        }).sort((a, b) => (a.sizeMB || 0) - (b.sizeMB || 0));

        let advantageOk = true;
        for (let i = 1; i < advantageByModel.length; i++) {
            const prev = advantageByModel[i - 1];
            const curr = advantageByModel[i];
            if (curr.sizeMB >= prev.sizeMB * 2) {
                if (curr.advantage < prev.advantage + 5) {
                    advantageOk = false;
                    break;
                }
            }
        }

        const acceptance = {
            smallStdOk: avgSmallStd > 0 ? avgSmallStd <= 2 : false,
            largeStdOk: avgLargeStd > 0 ? avgLargeStd <= 5 : false,
            advantageOk: advantageOk,
            avgSmallStd: avgSmallStd,
            avgLargeStd: avgLargeStd,
            advantageByModel: advantageByModel
        };

        // Construct Report Data matching Single-Round Schema
        const reportData = {
            timestamp: new Date().toISOString(),
            improvementOverStd: improvement.toFixed(2) + '%',
            networkContext: {
                type: netState.type,
                downlinkMbps: netState.downlink,
                rttMs: netState.rtt,
                compressionRatio: 1.0
            },
            seqLoad: {
                avgLatency: seq.avgLatency.toFixed(2),
                fps: seq.fps,
                fpsBoxplot: seq.fps.boxplot,
                totalLoads: seq.loads.length,
                details: seq.loads,
                modelSizes: seq.modelStats,
                modelRuns: seq.modelRuns
            },
            stdLod: {
                avgLatency: std.avgLatency.toFixed(2),
                fps: std.fps,
                fpsBoxplot: std.fps.boxplot,
                totalLoads: std.loads.length,
                details: std.loads,
                modelSizes: std.modelStats,
                modelRuns: std.modelRuns
            },
            mtWeb3drc: {
                avgLatency: mt.avgLatency.toFixed(2),
                fps: mt.fps,
                fpsBoxplot: mt.fps.boxplot,
                totalLoads: mt.loads.length,
                details: mt.loads,
                modelSizes: mt.modelStats,
                modelRuns: mt.modelRuns
            },
            acceptance: acceptance,
            userAgent: navigator.userAgent,
            rounds: rounds // Extra field to indicate multi-round, acceptable as it doesn't break existing keys
        };

        // Text Report for Alert/Console
        const formatFPS = (res) => {
            const fmin = res.fps.min !== undefined && res.fps.min !== Infinity ? res.fps.min.toFixed(1) : '-';
            const fmax = res.fps.max !== undefined && res.fps.max !== 0 ? res.fps.max.toFixed(1) : '-';
            const favg = res.fps.avg !== undefined && res.fps.avg !== 0 ? res.fps.avg.toFixed(1) : '-';
            let fsta = '-';
            if (res.fps.stable !== undefined && res.fps.stable !== 0) {
                fsta = res.fps.stable.toFixed(1);
            } else if (res.fps.samples && res.fps.samples.length > 0) {
                fsta = computeBoxPlot(res.fps.samples).median.toFixed(1);
            }
            return `Fmin ${fmin} | Fmax ${fmax} | Favg ${favg} | Fsta ${fsta}`;
        };

        const report = `
📊 Multi-Round Benchmark Report (${rounds} Rounds)
--------------------------------------------------
1. Seq-Load (Baseline)
   - Avg Latency: ${seq.avgLatency.toFixed(1)} ms
   - FPS: ${formatFPS(seq)}

2. Traditional (Std-LOD)
   - Avg Latency: ${std.avgLatency.toFixed(1)} ms
   - FPS: ${formatFPS(std)}

3. MT-Web3DRC (Ours)
   - Avg Latency: ${mt.avgLatency.toFixed(1)} ms
   - FPS: ${formatFPS(mt)}

--------------------------------------------------
--------------------------------------------------
🏆 Improvement (MT vs Std): ${improvement.toFixed(2)}% Faster
`;
        console.log(report);
        const serverLogMsg = "\n💾 日志已自动保存到服务器 logs 目录";
        setTimeout(() => alert(report + serverLogMsg), 100);

        // Save to Server with Unified Schema
        this.saveReport(report, reportData);
    }

    saveReport(textReport, data) {
        // If data already has the structure we want (results root), use it directly
        // But showReport constructs 'reportData' which is assigned to 'results' key in body
        // Here 'data' IS 'reportData'

        fetch('/api/save-benchmark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                results: data, // Maps to 'results' key in JSON
                timestamp: data.timestamp,
                userAgent: data.userAgent
            })
        }).then(res => res.json())
            .then(data => console.log('✅ Benchmark log saved to server:', data.filename))
            .catch(err => console.warn('❌ Failed to save benchmark log:', err));
    }

    async runRound(strategy, modelIndex = currentModelIndex, roundIndex = 1) {
        console.log(`⏱️ Running Benchmark: ${strategy}`);
        this.strategy = strategy;

        // Reset frame count for warmup logic
        this.frameCount = 0;

        // Reset results for this strategy
        this.results[strategy] = {
            loads: [],
            total: 0,
            avg: 0,
            // 新增 stable 初始值，避免 later undefined
            fps: { min: Infinity, max: 0, avg: 0, stdDev: 0, stable: 0, samples: [] },
            modelStats: []
        };

        // 1. Switch Strategy
        const selector = document.getElementById('strategy-selector');
        selector.value = strategy;
        // Trigger change event if needed (here we just set value)

        // 2. Reset Scene
        clearScene();

        // 确保主模型重新加载 (Using currentModelIndex)
        currentModelIndex = modelIndex;
        await loadMainModel(currentModelIndex);

        // Reset Camera
        camera.position.copy(this.cameraStartPos);
        camera.lookAt(0, 0, -200);

        // 3. Auto Move (Simulate user walking forward)
        const baseDuration = 15000; // 15 seconds at 1x
        const duration = baseDuration / this.speedMultiplier;
        const startTime = Date.now();

        return new Promise(resolve => {
            const interval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);

                // Linear interpolation
                camera.position.lerpVectors(this.cameraStartPos, this.cameraEndPos, progress);

                // Trigger grid check (Simulate on-demand loading for Standard)
                checkVisibleGrids();

                if (progress >= 1) {
                    clearInterval(interval);

                    // 等待所有挂起的加载完成，确保统计数据准确
                    this.waitForPending().then(() => {
                        this.calculateStats(strategy);
                        const res = this.results[strategy];
                        const modelInfo = availableModels[modelIndex] || { id: 'unknown', name: 'unknown' };
                        const snapshot = {
                            loads: [...res.loads],
                            total: res.total,
                            avg: res.avg,
                            fps: {
                                min: res.fps.min,
                                max: res.fps.max,
                                avg: res.fps.avg,
                                stdDev: res.fps.stdDev,
                                stable: res.fps.stable,           // ← 加入稳定帧率
                                cv: res.fps.cv,
                                rangePct: res.fps.rangePct,
                                low1: res.fps.low1,
                                low5: res.fps.low5,
                                samples: [...res.fps.samples]
                            },
                            fpsInternal: res.fpsInternal ? { ...res.fpsInternal } : null,
                            memoryAvg: res.memoryAvg,
                            memoryMax: res.memoryMax,
                            frameStats: res.frameStats ? { ...res.frameStats } : null,
                            modelStats: [...res.modelStats],
                            modelInfo: {
                                id: modelInfo.id,
                                name: modelInfo.name,
                                sizeMB: currentModelSizeMB,
                                scale: currentModelScale,
                                index: modelIndex
                            },
                            strategy: strategy,
                            round: roundIndex
                        };
                        resolve(snapshot);
                    });
                }
            }, 16); // ~60fps
        });
    }

    async waitForPending() {
        if (loadingBlocks.size === 0) return;

        console.log(`⏳ Waiting for ${loadingBlocks.size} pending loads...`);
        const startWait = Date.now();

        return new Promise(resolve => {
            const check = setInterval(() => {
                if (loadingBlocks.size === 0 || (Date.now() - startWait > 10000)) { // Max wait 10s
                    clearInterval(check);
                    if (loadingBlocks.size > 0) console.warn('⚠️ Benchmark timeout waiting for pending blocks');
                    resolve();
                }
            }, 100);
        });
    }

    recordLoad(blockKey, latency, isPrefetch, loadedSuccessfully, sizeMB = 2.0) {
        if (!this.running) return;
        if (!loadedSuccessfully) return;

        // 计算有效延迟 (Effective Latency)
        // 对于 MT-Web3DRC:
        // - 如果是 Prefetch (后台加载)，对用户来说延迟是 0 (除非用户走得比下载还快，那就变成了 On-Demand)
        // - 这里简化模型：Prefetch = 0ms cost
        // 对于 Standard:
        // - 必须是 On-Demand，延迟 = RTT + Download

        let effectiveLatency = latency;

        if (this.strategy === 'mt-web3drc' && isPrefetch) {
            effectiveLatency = 0;
        }

        this.results[this.strategy].loads.push(effectiveLatency);
        this.results[this.strategy].modelStats.push({ id: blockKey, sizeMB: sizeMB });
        console.log(`📊 [Benchmark] ${this.strategy} load: ${blockKey}, cost: ${effectiveLatency.toFixed(1)}ms, size: ${sizeMB.toFixed(2)}MB`);
    }
    recordFPS(fps, pureProcessingTimeMs = null) {
        if (!this.running || !this.strategy) return;

        // --- Warmup Logic: Ignore first 60 frames (approx. 1s) ---
        this.frameCount = (this.frameCount || 0) + 1;
        if (this.frameCount <= stabilityConfig.warmupFrames) {
            return;
        }

        // 使用改进的 FPS 范围检查，过滤异常低值
        if (fps <= 0 || fps >= 200 || fps < 10) {
            console.debug(`跳过异常 FPS 值: ${fps.toFixed(2)}`);
            return;
        }

        // 记录FPS值用于统计
        this.fpsSamples.push(fps);
        
        const stats = this.results[this.strategy].fps;
        stats.samples.push(fps);

        // 实时更新极值
        if (fps < stats.min) stats.min = fps;
        if (fps > stats.max) stats.max = fps;
    }

    calculateStats(strategy) {
        const res = this.results[strategy];

        // Latency Stats
        const loads = res.loads;
        if (loads.length > 0) {
            const total = loads.reduce((a, b) => a + b, 0);
            res.total = total;
            res.avg = total / loads.length;
        }

        // FPS Stats - 回到阈值方法，避免过度严格的连续段过滤
        const fpsSamples = res.fps.samples;
        if (fpsSamples.length > 0) {
            // 使用阈值方法过滤异常值
            const validFps = fpsSamples.filter(fps => fps >= 30 && fps <= 120);
            
            if (validFps.length > 0) {
                // 对过滤后的数据进行统计
                const totalFps = validFps.reduce((a, b) => a + b, 0);
                const avgFps = totalFps / validFps.length;
                const minFps = Math.min(...validFps);

                // 原始样本计算最大值，避免因过滤范围导致 Fmax 人为降低
                const maxFpsRaw = Math.max(...fpsSamples);

                // 计算标准差
                const squareDiffs = validFps.map(value => Math.pow(value - avgFps, 2));
                const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / validFps.length;
                const stdDev = Math.sqrt(avgSquareDiff);

                // 计算变异系数和范围百分比
                const cv = avgFps > 0 ? stdDev / avgFps : 0;
                const rangePct = avgFps > 0 ? ((maxFpsRaw - minFps) / avgFps) * 100 : 0;

                // 计算稳定帧率 (去除波动较大的帧)
                const threshold = avgFps * 0.1; // 10%的阈值
                const stableSamples = validFps.filter(fps => Math.abs(fps - avgFps) <= threshold);
                const stableAvg = stableSamples.length > 0 ? 
                    stableSamples.reduce((a, b) => a + b, 0) / stableSamples.length : avgFps;

                // 更新结果
                res.fps.min = minFps;
                res.fps.max = maxFpsRaw;          // <-- use raw max
                res.fps.avg = avgFps;
                res.fps.stdDev = stdDev;
                res.fps.stable = stableAvg;
                res.fps.cv = cv;
                res.fps.rangePct = rangePct;

                // 保留过滤后的样本用于其他计算
                res.fps.samples = validFps;
            } else {
                // 如果没有有效的FPS样本，使用原始数据
                const totalFps = fpsSamples.reduce((a, b) => a + b, 0);
                const avgFps = totalFps / fpsSamples.length;
                const minFps = Math.min(...fpsSamples);
                const maxFpsRaw = Math.max(...fpsSamples);

                res.fps.min = minFps;
                res.fps.max = maxFpsRaw;          // <-- 同样保留原始峰值
                res.fps.avg = avgFps;
                res.fps.stable = avgFps; // 当没有有效样本时，使用平均值作为稳定值
                res.fps.samples = [...fpsSamples];
            }
        }
    }

    showReport() {
        const base = this.results['seq-load'].avg;
        const std = this.results['traditional'].avg;
        const mt = this.results['mt-web3drc'].avg;

        // Prevent division by zero
        let improvement = 0;
        // Compare MT against Traditional (Std-LOD) as the main competitor, or Baseline?
        // Usually paper compares against State-of-the-Art (Std-LOD)
        // Let's calculate improvement over Std-LOD
        if (std > 0) {
            improvement = ((std - mt) / std * 100);
        } else if (mt === 0 && std === 0) {
            improvement = 0;
        } else {
            improvement = -100; // worse or undefined
        }

        // 获取当前网络配置
        const netState = getSimulatedNetworkState();

        const reportData = {
            timestamp: new Date().toISOString(),
            improvementOverStd: improvement.toFixed(2) + '%',
            networkContext: {
                type: netState.type,
                downlinkMbps: netState.downlink,
                rttMs: netState.rtt,
                compressionRatio: 1.0 // 暂时固定，如需恢复可从全局变量读取
            },
            seqLoad: {
                avgLatency: base.toFixed(2),
                fps: this.results['seq-load'].fps,
                fpsBoxplot: this.results['seq-load'].fps.boxplot,
                totalLoads: this.results['seq-load'].loads.length,
                details: this.results['seq-load'].loads,
                modelSizes: this.results['seq-load'].modelStats
            },
            stdLod: {
                avgLatency: std.toFixed(2),
                fps: this.results['traditional'].fps,
                fpsBoxplot: this.results['traditional'].fps.boxplot,
                totalLoads: this.results['traditional'].loads.length,
                details: this.results['traditional'].loads,
                modelSizes: this.results['traditional'].modelStats
            },
            mtWeb3drc: {
                avgLatency: mt.toFixed(2),
                fps: this.results['mt-web3drc'].fps,
                fpsBoxplot: this.results['mt-web3drc'].fps.boxplot,
                totalLoads: this.results['mt-web3drc'].loads.length,
                details: this.results['mt-web3drc'].loads,
                modelSizes: this.results['mt-web3drc'].modelStats
            },
            userAgent: navigator.userAgent
        };

        // 1. 发送到服务端保存
        fetch('/api/save-benchmark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                results: reportData,
                timestamp: reportData.timestamp,
                userAgent: reportData.userAgent
            })
        }).then(res => res.json())
            .then(data => console.log('✅ Benchmark log saved to server:', data.filename))
            .catch(err => console.warn('❌ Failed to save benchmark log:', err));

        // 2. 构造显示消息
        const formatFPS = (res) => {
            const fmin = res.fps.min !== undefined && res.fps.min !== Infinity ? res.fps.min.toFixed(1) : '-';
            const fmax = res.fps.max !== undefined && res.fps.max !== 0 ? res.fps.max.toFixed(1) : '-';
            const favg = res.fps.avg !== undefined && res.fps.avg !== 0 ? res.fps.avg.toFixed(1) : '-';
            let fsta = '-';
            if (res.fps.stable !== undefined && res.fps.stable !== 0) {
                fsta = res.fps.stable.toFixed(1);
            } else if (res.fps.samples && res.fps.samples.length > 0) {
                fsta = computeBoxPlot(res.fps.samples).median.toFixed(1);
            }
            return `Fmin ${fmin} | Fmax ${fmax} | Favg ${favg} | Fsta ${fsta}`;
        };

        const msg = `
🏆 基准测试完成 (Benchmark Complete)

📊 Seq-Load (Baseline):
   - 平均延迟: ${base.toFixed(1)} ms
   - FPS: ${formatFPS(this.results['seq-load'])}

📉 Std-LOD (Traditional):
   - 平均延迟: ${std.toFixed(1)} ms
   - FPS: ${formatFPS(this.results['traditional'])}

🚀 MT-Web3DRC (Ours):
   - 平均延迟: ${mt.toFixed(1)} ms
   - FPS: ${formatFPS(this.results['mt-web3drc'])}

🎉 较 Std-LOD 性能提升:
   👉 ${improvement.toFixed(1)}% 
        `;

        // 3. 提示信息更新
        const serverLogMsg = "\n💾 日志已自动保存到服务器 logs 目录";
        console.log(msg + serverLogMsg);
        console.log('Detailed Report:', reportData);
        setTimeout(() => alert(msg + serverLogMsg), 100);
    }
}

// 初始化 Benchmark
window.benchmark = new BenchmarkSystem();

/**
 * 检查当前视锥体内的 Grid，触发按需加载 (On-Demand Loading)
 * 这是 Standard 策略的基线行为
 */
function checkVisibleGrids() {
    // 假设 Grid Size = 50
    const gridSize = 50;
    const cx = Math.floor(camera.position.x / gridSize);
    const cz = Math.floor(camera.position.z / gridSize);

    // 检查前方 1-2 个 Grid
    // 简单起见，我们检查当前所在的 Grid 和 前方一个 Grid
    // 假设相机朝向 -Z

    // 获取当前基础模型ID，作为命名空间 (Requirement: OriginalName + Suffix)
    const currentModelId = (availableModels[currentModelIndex] && availableModels[currentModelIndex].id) || 'default';

    let forwardSteps = [0, -1, -2];
    if (currentModelScale === 'small') forwardSteps = [0, -1, -2, -3];
    if (currentModelScale === 'large') forwardSteps = [0, -1];

    const gridsToCheck = forwardSteps.map(step => `${currentModelId}_copy_${cx}_${cz + step}`);

    gridsToCheck.forEach(gridId => {
        const match = gridId.match(/_copy_(-?\d+)_(-?\d+)$/);
        const gx = match ? parseInt(match[1]) : cx;
        const gz = match ? parseInt(match[2]) : cz;
        const center = new THREE.Vector3(gx * gridSize, 0, gz * gridSize);
        const distance = center.distanceTo(camera.position);
        let lodLevel = selectLodLevel(currentModelSizeMB, distance, getCurrentStrategy());

        // --- Geometry Budgeting (GPU Simulation) ---
        // 如果当前渲染的三角形总数超过了 maxTriangles，强制使用最低 LOD
        if (stabilityConfig.maxTriangles > 0 && renderer.info.render.triangles > stabilityConfig.maxTriangles) {
            lodLevel = stabilityConfig.minLod;
            // 简单日志，避免刷屏
            if (Math.random() < 0.01) console.warn(`⚠️ GPU Budget Exceeded (${renderer.info.render.triangles} > ${stabilityConfig.maxTriangles}), Forcing LOD 1`);
        }

        if (loadedBlocks.has(gridId)) {
            const existing = loadedBlocks.get(gridId);
            const currentLod = existing && existing.userData ? existing.userData.lodLevel || stabilityConfig.minLod : stabilityConfig.minLod;
            if (currentLod <= lodLevel || distance > 120) {
                return;
            }
            if (existing) {
                scene.remove(existing);
                existing.traverse(obj => {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) {
                            obj.material.forEach(mat => mat.dispose());
                        } else {
                            obj.material.dispose();
                        }
                    }
                });
            }
            loadedBlocks.delete(gridId);
        }

        if (!loadedBlocks.has(gridId) && !loadingBlocks.has(gridId)) {

            // 策略区分：
            // 如果是 MT-Web3DRC，我们主要依赖后端的 Prefetch 指令。
            // 但为了防止预测失败（兜底），如果用户已经走到了该 Grid 还没加载出来，
            // 此时必须强制进行“按需加载”，但这会产生延迟。
            // 这里我们不做特殊拦截，因为如果 Prefetch 成功，loadedBlocks 应该已经有了。
            // 唯一需要注意的是避免和正在进行的 Prefetch 撞车 (虽然 loadingBlocks 已经处理了)

            // 立即标记为正在加载，防止并发请求
            loadingBlocks.add(gridId);

            // 获取当前基础模型ID，传递给服务端作为虚拟块的替身
            const currentModelId = availableModels[currentModelIndex] ? availableModels[currentModelIndex].id : null;
            const baseQuery = currentModelId ? `&baseModelId=${encodeURIComponent(currentModelId)}` : '';

            fetch(`/api/get-model-block?modelId=${encodeURIComponent(gridId)}&lodLevel=${lodLevel}${baseQuery}`)
                .then(r => r.json())
                .then(data => {
                    if (data && data.code === 200 && data.data && data.data.url) {
                        // loadingBlocks 已在上方添加，但 loadGltfBlock 内部也会检查
                        // 为了确保逻辑一致，我们需要让 loadGltfBlock 接管
                        // 但 loadGltfBlock 会再次 add(blockKey)
                        // 所以我们在调用前先 delete，或者修改 loadGltfBlock 逻辑
                        // 最简单的方式：这里先 delete，把责任转交给 loadGltfBlock
                        loadingBlocks.delete(gridId);
                        loadGltfBlock(data.data.url, gridId, false, data.data.size || 0, lodLevel);
                    } else {
                        createSimulatedBlock(gridId);
                        loadingBlocks.delete(gridId);
                    }
                })
                .catch(() => {
                    createSimulatedBlock(gridId);
                    loadingBlocks.delete(gridId);
                });
        }
    });
}

// 添加 Benchmark 按钮到 UI
(function addBenchmarkUI() {
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.bottom = '10px';
    container.style.right = '10px';
    container.style.zIndex = '3000';
    container.style.display = 'flex';
    container.style.gap = '5px';
    container.style.alignItems = 'center';

    // Speed Controls
    const speeds = [0.5, 1, 2];
    speeds.forEach(speed => {
        const btn = document.createElement('button');
        btn.textContent = `${speed}x`;
        btn.style.padding = '5px 10px';
        btn.style.background = '#444';
        btn.style.color = 'white';
        btn.style.border = '1px solid #666';
        btn.style.borderRadius = '3px';
        btn.style.cursor = 'pointer';

        btn.onclick = () => {
            window.benchmark.setSpeed(speed);
            // Visual feedback
            Array.from(container.children).forEach(c => {
                if (c.textContent.endsWith('x')) c.style.background = '#444';
            });
            btn.style.background = '#2196f3';
        };

        if (speed === 1) btn.style.background = '#2196f3'; // Default active
        container.appendChild(btn);
    });

    const btn = document.createElement('button');
    btn.textContent = '🚀 Run Benchmark';
    btn.style.padding = '10px 20px';
    btn.style.background = '#2196f3';
    btn.style.color = 'white';
    btn.style.border = 'none';
    btn.style.borderRadius = '5px';
    btn.style.cursor = 'pointer';
    btn.style.fontWeight = 'bold';

    btn.onclick = () => window.benchmark.runSuite();

    container.appendChild(btn);
    document.body.appendChild(container);
})();

// 初始加载
loadMainModel(0);
