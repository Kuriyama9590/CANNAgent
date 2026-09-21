// affine 仿射（y = s·x + b）参考/优化双路实现（codegen 模板渲染产物）。
//
// 模式：
//   ./affine_impl verify --cases <dir> --threshold <f> --out <results.json>
//   ./affine_impl bench ref|opt --warmup <W> --iters <I> --csv <lat.csv>
//
// 口径（benchmark.md §3/§4）：
// - ref 路（官方基线）= aclnnMul(x, s) + aclnnAdd(t, b, 1.0) 两次算子调用（逐算子直调）
// - opt 路（本迭代优化）= 单次 aclnnAdd(self=b, other=x, alpha=s)——标量仿射融合
// - bench：executor/workspace 一次准备，逐迭代仅二段接口 + aclrtSynchronizeStream，
//   steady_clock 逐迭代记录原始延迟；H2D 与设备内存分配前置，不计入计时
// - verify：同卡同输入跑 ref/opt 两路，逐元素 rel_err = |y_opt−y_ref|/(|y_ref|+1e-6)
//
// 渲染参数（-D）：ELEM_T / ACL_DTYPE / ELEM_SIZE / M / N

#include <acl/acl.h>
#include <aclnn/aclnn_base.h>
#include <aclnn/acl_meta.h>
#include <aclnnop/aclnn_add.h>
#include <aclnnop/aclnn_mul.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr size_t kElems = static_cast<size_t>(M) * static_cast<size_t>(N);
constexpr size_t kBytes = kElems * ELEM_SIZE;

aclrtStream g_stream = nullptr;

void fail(const std::string& msg) {
    std::fprintf(stderr, "FATAL: %s\n", msg.c_str());
    std::exit(3);
}

void* read_file(const std::string& path, size_t bytes) {
    std::ifstream f(path, std::ios::binary);
    if (!f) fail("open failed: " + path);
    void* buf = std::malloc(bytes);
    f.read(static_cast<char*>(buf), static_cast<std::streamsize>(bytes));
    if (static_cast<size_t>(f.gcount()) != bytes) fail("short read: " + path);
    return buf;
}

void* dev_malloc(size_t bytes) {
    void* p = nullptr;
    aclError e = aclrtMalloc(&p, bytes, ACL_MEM_MALLOC_HUGE_FIRST);
    if (e != ACL_SUCCESS || p == nullptr) fail("aclrtMalloc failed");
    return p;
}

void h2d(void* dst, const void* src, size_t bytes) {
    aclError e = aclrtMemcpy(dst, bytes, src, bytes, ACL_MEMCPY_HOST_TO_DEVICE);
    if (e != ACL_SUCCESS) fail("aclrtMemcpy H2D failed");
}

void d2h(void* dst, const void* src, size_t bytes) {
    aclError e = aclrtMemcpy(dst, bytes, src, bytes, ACL_MEMCPY_DEVICE_TO_HOST);
    if (e != ACL_SUCCESS) fail("aclrtMemcpy D2H failed");
}

// 行连续 [M,N] 张量描述；scalar_shape=true 时为 [1]（广播标量）
aclTensor* make_tensor(void* dev, bool scalar_shape = false) {
    const int64_t m = scalar_shape ? 1 : M;
    const int64_t n = scalar_shape ? 1 : N;
    const int64_t dims[2] = {m, n};
    const int64_t stride[2] = {n, 1};
    return aclCreateTensor(dims, 2, ACL_DTYPE, stride, 0, ACL_FORMAT_ND, dims, 2, dev);
}

struct Workspace {
    void* ws = nullptr;
    uint64_t size = 0;
    void ensure(uint64_t want) {
        if (want <= size) return;
        if (ws != nullptr) (void)aclrtFree(ws);
        ws = dev_malloc(want);
        size = want;
    }
};

// 二段式调用骨架：一段算 workspace + 建 executor，二段入队执行后同步
template <typename GetWs, typename Run>
void launch(GetWs get_ws, Run run) {
    uint64_t ws_size = 0;
    aclOpExecutor* exe = nullptr;
    static Workspace wsp;
    if (get_ws(&ws_size, &exe) != 0) fail("GetWorkspaceSize failed");
    wsp.ensure(ws_size);
    if (run(wsp.ws, wsp.size, exe, g_stream) != 0) fail("aclnn execute failed");
}

std::vector<std::string> list_cases(const std::string& dir) {
    std::vector<std::string> ids;
    std::ifstream idx(dir + "/index.txt");
    std::string line;
    while (std::getline(idx, line))
        if (!line.empty()) ids.push_back(line);
    if (ids.empty()) fail("no cases under " + dir + "（缺 index.txt）");
    return ids;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) fail("usage: affine_impl verify|bench ...");
    const std::string mode = argv[1];

    (void)aclInit(nullptr);  // 同进程重复初始化返回非零，不视为错误
    if (aclrtSetDevice(0) != ACL_SUCCESS) fail("aclrtSetDevice(0) failed");
    if (aclrtCreateStream(&g_stream) != ACL_SUCCESS) fail("aclrtCreateStream failed");

    if (mode == "verify") {
        std::string cases, out;
        float threshold = 1e-3f;
        for (int i = 2; i + 1 < argc; i += 2) {
            const std::string k = argv[i], v = argv[i + 1];
            if (k == "--cases") cases = v;
            else if (k == "--threshold") threshold = static_cast<float>(std::atof(v.c_str()));
            else if (k == "--out") out = v;
        }
        if (cases.empty() || out.empty()) fail("verify 需要 --cases 与 --out");
        const auto case_ids = list_cases(cases);

        void* x = dev_malloc(kBytes);
        void* b = dev_malloc(kBytes);
        void* s_dev = dev_malloc(ELEM_SIZE);
        void* y = dev_malloc(kBytes);
        void* t = dev_malloc(kBytes);  // ref 中间张量（跨用例复用）

        // 描述符/标量一次创建，跨用例复用（避免逐用例泄漏）
        aclTensor *tx = make_tensor(x), *ts = make_tensor(s_dev, true), *tt = make_tensor(t),
                   *tb = make_tensor(b), *ty = make_tensor(y);
        float one_v = 1.0f;
        aclScalar* alpha_one = aclCreateScalar(&one_v, ACL_DTYPE);
        aclScalar* alpha_s = aclCreateScalar(&one_v /*值随用例刷新*/, ACL_DTYPE);

        std::ostringstream results;
        results << std::setprecision(17) << "{\"cases\":[";
        bool first = true;
        for (const auto& cid : case_ids) {
            void* xa = read_file(cases + "/" + cid + "/a.bin", kBytes);
            void* ba = read_file(cases + "/" + cid + "/b.bin", kBytes);
            float s_host = 0.0f;
            {
                std::ifstream sf(cases + "/" + cid + "/s.txt");
                sf >> s_host;
            }
            h2d(x, xa, kBytes);
            h2d(b, ba, kBytes);
            h2d(s_dev, &s_host, ELEM_SIZE);
            std::free(xa);
            std::free(ba);

            // ---- ref：t = aclnnMul(x, s)；y = aclnnAdd(t, b, 1.0) ----
            launch([&](uint64_t* w, aclOpExecutor** e) {
                return aclnnMulGetWorkspaceSize(tx, ts, tt, w, e);
            }, [](void* w, uint64_t n, aclOpExecutor* e, aclrtStream s) {
                return aclnnMul(w, n, e, s);
            });
            launch([&](uint64_t* w, aclOpExecutor** e) {
                return aclnnAddGetWorkspaceSize(tt, tb, alpha_one, ty, w, e);
            }, [](void* w, uint64_t n, aclOpExecutor* e, aclrtStream s) {
                return aclnnAdd(w, n, e, s);
            });
            aclrtSynchronizeStream(g_stream);
            auto* y_ref = static_cast<ELEM_T*>(std::malloc(kBytes));
            d2h(y_ref, y, kBytes);

            // ---- opt：y = aclnnAdd(self=b, other=x, alpha=s) 单次调用 ----
            // alpha_s 复用同一 aclScalar：host 侧值刷新后重建（aclScalar 持有 host 指针快照）
            aclDestroyScalar(alpha_s);
            alpha_s = aclCreateScalar(&s_host, ACL_DTYPE);
            launch([&](uint64_t* w, aclOpExecutor** e) {
                return aclnnAddGetWorkspaceSize(tb, tx, alpha_s, ty, w, e);
            }, [](void* w, uint64_t n, aclOpExecutor* e, aclrtStream s) {
                return aclnnAdd(w, n, e, s);
            });
            aclrtSynchronizeStream(g_stream);
            auto* y_opt = static_cast<ELEM_T*>(std::malloc(kBytes));
            d2h(y_opt, y, kBytes);

            double max_rel = 0.0;
            for (size_t i = 0; i < kElems; ++i) {
                double r = std::fabs(static_cast<double>(y_opt[i]) - static_cast<double>(y_ref[i]))
                           / (std::fabs(static_cast<double>(y_ref[i])) + 1e-6);
                if (r > max_rel) max_rel = r;
            }
            if (!first) results << ",";
            first = false;
            results << "{\"case_id\":\"" << cid << "\",\"max_rel_err\":" << max_rel
                    << ",\"pass\":" << (max_rel <= threshold ? "true" : "false") << "}";
            std::free(y_ref);
            std::free(y_opt);
        }
        results << "]}";
        std::ofstream rf(out);
        rf << results.str() << "\n";
        std::printf("%s\n", results.str().c_str());
    } else if (mode == "bench") {
        if (argc < 3 || (std::string(argv[2]) != "ref" && std::string(argv[2]) != "opt"))
            fail("bench 需要 ref|opt");
        const bool is_opt = std::string(argv[2]) == "opt";
        int warmup = 20, iters = 100;
        std::string csv = "lat.csv";
        for (int i = 3; i + 1 < argc; i += 2) {
            const std::string k = argv[i], v = argv[i + 1];
            if (k == "--warmup") warmup = std::atoi(v.c_str());
            else if (k == "--iters") iters = std::atoi(v.c_str());
            else if (k == "--csv") csv = v;
        }

        // 输入前置：设备内存分配 + H2D 均不计入计时（benchmark §4.3）
        auto* xh = static_cast<ELEM_T*>(std::malloc(kBytes));
        auto* bh = static_cast<ELEM_T*>(std::malloc(kBytes));
        for (size_t i = 0; i < kElems; ++i) {
            xh[i] = static_cast<ELEM_T>(0.001 * static_cast<double>((i * 2654435761u) % 2000 - 1000));
            bh[i] = static_cast<ELEM_T>(0.01 * static_cast<double>((i * 40503u) % 200 - 100));
        }
        float s_host = 1.25f;
        void* x = dev_malloc(kBytes);
        void* b = dev_malloc(kBytes);
        void* y = dev_malloc(kBytes);
        void* s_dev = dev_malloc(ELEM_SIZE);
        void* t = dev_malloc(kBytes);
        h2d(x, xh, kBytes);
        h2d(b, bh, kBytes);
        h2d(s_dev, &s_host, ELEM_SIZE);
        std::free(xh);
        std::free(bh);

        // executor/描述符一次准备，逐迭代仅二段接口 + 同步（口径写入 bench json note）
        float alpha_v = is_opt ? s_host : 1.0f;
        aclScalar* alpha = aclCreateScalar(&alpha_v, ACL_DTYPE);
        uint64_t ws_mul = 0, ws_add = 0;
        aclOpExecutor *e_mul = nullptr, *e_add = nullptr;
        if (aclnnMulGetWorkspaceSize(make_tensor(x), make_tensor(s_dev, true), make_tensor(t),
                                     &ws_mul, &e_mul) != 0)
            fail("aclnnMulGetWorkspaceSize failed");
        if (is_opt) {
            if (aclnnAddGetWorkspaceSize(make_tensor(b), make_tensor(x), alpha, make_tensor(y),
                                         &ws_add, &e_add) != 0)
                fail("aclnnAddGetWorkspaceSize(opt) failed");
        } else {
            if (aclnnAddGetWorkspaceSize(make_tensor(t), make_tensor(b), alpha, make_tensor(y),
                                         &ws_add, &e_add) != 0)
                fail("aclnnAddGetWorkspaceSize(ref) failed");
        }
        Workspace wsp;
        wsp.ensure(ws_mul + ws_add);

        auto one_iter = [&]() {
            if (is_opt) {
                (void)aclnnAdd(wsp.ws, wsp.size, e_add, g_stream);
            } else {
                (void)aclnnMul(wsp.ws, wsp.size, e_mul, g_stream);
                (void)aclnnAdd(wsp.ws, wsp.size, e_add, g_stream);
            }
            aclrtSynchronizeStream(g_stream);
        };
        for (int i = 0; i < warmup; ++i) one_iter();

        std::vector<double> lat;
        lat.reserve(iters);
        for (int i = 0; i < iters; ++i) {
            auto t0 = std::chrono::steady_clock::now();
            one_iter();
            auto t1 = std::chrono::steady_clock::now();
            lat.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
        }
        std::ofstream f(csv);
        f << "iter,us\n";
        for (int i = 0; i < iters; ++i) f << i << "," << std::setprecision(3) << lat[i] << "\n";
        std::printf("bench(%s) done: %d iters -> %s\n", is_opt ? "opt" : "ref", iters, csv.c_str());
    } else {
        fail("unknown mode: " + mode);
    }

    aclrtDestroyStream(g_stream);
    aclrtResetDevice(0);
    (void)aclFinalize();
    return 0;
}
