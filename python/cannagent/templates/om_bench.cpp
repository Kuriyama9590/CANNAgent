// om 整图基准（bench 第三腿：ATC 门槛对照，D4）。
//   ./om_bench --om <model.om> --input <x.bin> --warmup <W> --iters <I> --csv <lat.csv>
// 口径与 affine_impl bench 相同：输入前置 H2D、逐迭代 aclmdlExecute + 同步、steady_clock 逐迭代记录。

#include <acl/acl.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace {

void fail(const std::string& msg) {
    std::fprintf(stderr, "FATAL: %s\n", msg.c_str());
    std::exit(3);
}

aclmdlDataset* make_dataset(aclmdlDesc* desc, bool is_input, const std::string& input_path,
                            std::vector<void*>& owned) {
    aclmdlDataset* ds = aclmdlCreateDataset();
    if (ds == nullptr) fail("aclmdlCreateDataset failed");
    size_t n = is_input ? aclmdlGetNumInputs(desc) : aclmdlGetNumOutputs(desc);
    for (size_t i = 0; i < n; ++i) {
        size_t bytes = is_input ? aclmdlGetInputSizeByIndex(desc, i)
                                : aclmdlGetOutputSizeByIndex(desc, i);
        void* dev = nullptr;
        if (aclrtMalloc(&dev, bytes, ACL_MEM_MALLOC_HUGE_FIRST) != ACL_SUCCESS)
            fail("aclrtMalloc(dataset buffer) failed");
        if (is_input) {
            std::ifstream f(input_path, std::ios::binary);
            if (!f) fail("open input failed: " + input_path);
            std::vector<char> buf(bytes, 0);
            f.read(buf.data(), static_cast<std::streamsize>(bytes));
            if (static_cast<size_t>(f.gcount()) != bytes)
                fail("input bin 短读（尺寸与图输入不符）");
            if (aclrtMemcpy(dev, bytes, buf.data(), bytes, ACL_MEMCPY_HOST_TO_DEVICE) != ACL_SUCCESS)
                fail("H2D failed");
        }
        aclDataBuffer* buf = aclCreateDataBuffer(dev, bytes);
        if (buf == nullptr) fail("aclCreateDataBuffer failed");
        if (aclmdlAddDatasetBuffer(ds, buf) != ACL_SUCCESS) fail("aclmdlAddDatasetBuffer failed");
        owned.push_back(dev);
    }
    return ds;
}

}  // namespace

int main(int argc, char** argv) {
    std::string om, input, csv = "lat_atc.csv";
    int warmup = 20, iters = 100;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::string k = argv[i], v = argv[i + 1];
        if (k == "--om") om = v;
        else if (k == "--input") input = v;
        else if (k == "--warmup") warmup = std::atoi(v.c_str());
        else if (k == "--iters") iters = std::atoi(v.c_str());
        else if (k == "--csv") csv = v;
    }
    if (om.empty() || input.empty()) fail("需要 --om 与 --input");

    (void)aclInit(nullptr);
    if (aclrtSetDevice(0) != ACL_SUCCESS) fail("aclrtSetDevice(0) failed");
    aclrtStream stream = nullptr;
    if (aclrtCreateStream(&stream) != ACL_SUCCESS) fail("aclrtCreateStream failed");

    uint32_t model_id = 0;
    if (aclmdlLoadFromFile(om.c_str(), &model_id) != ACL_SUCCESS) fail("aclmdlLoadFromFile failed");
    aclmdlDesc* desc = aclmdlCreateDesc();
    if (aclmdlGetDesc(desc, model_id) != ACL_SUCCESS) fail("aclmdlGetDesc failed");

    std::vector<void*> owned;
    aclmdlDataset* in = make_dataset(desc, true, input, owned);
    aclmdlDataset* out = make_dataset(desc, false, "", owned);

    auto one_iter = [&]() {
        if (aclmdlExecute(model_id, in, out) != ACL_SUCCESS) fail("aclmdlExecute failed");
        aclrtSynchronizeStream(stream);
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
    std::printf("bench(atc om) done: %d iters -> %s\n", iters, csv.c_str());
    return 0;
}
