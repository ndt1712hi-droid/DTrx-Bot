// Dữ liệu cấu hình màn hình (Pixels & DPI)
// Định dạng: "tên dòng máy": { pixels: "W x H", dpi?: "số" }
// Lưu ý: Với iPhone 14-18 Pro Max, chỉ cần gửi pixels (không có dpi)
export const SCREEN_SPECS = {
    // --- IPHONE (Chỉ Pixels, không DPI) ---
    "iphone 14 pro max": { pixels: "2796 × 1290" },
    "iphone 15 pro max": { pixels: "2796 × 1290" },
    "iphone 16 pro max": { pixels: "2868 × 1320" },
    "iphone 17 pro max": { pixels: "2868 × 1320" },
    "iphone 18 pro max": { pixels: "2868 × 1320" },
    // --- CÁC DÒNG MÁY KHÁC (Có cả Pixels & DPI) ---
    // Android Flagship
    "samsung galaxy s24 ultra": { pixels: "3120 × 1440", dpi: "505" },
    "samsung galaxy s24 plus": { pixels: "3120 × 1440", dpi: "513" },
    "samsung galaxy s24": { pixels: "2340 × 1080", dpi: "416" },
    "google pixel 9 pro xl": { pixels: "1344 × 2992", dpi: "482" },
    "google pixel 9": { pixels: "1080 × 2424", dpi: "422" },
    "google pixel 8 pro": { pixels: "1344 × 2992", dpi: "490" },
    "google pixel 8": { pixels: "1080 × 2400", dpi: "424" },
    "xiaomi 14 pro": { pixels: "3200 × 1440", dpi: "522" },
    "xiaomi 14": { pixels: "2670 × 1200", dpi: "460" },
    "oneplus 12": { pixels: "3168 × 1440", dpi: "510" },
    // Laptop & Monitor phổ biến
    "macbook pro 14 inch": { pixels: "3024 × 1964", dpi: "254" },
    "macbook pro 16 inch": { pixels: "3456 × 2234", dpi: "254" },
    "dell xps 13": { pixels: "1920 × 1200", dpi: "188" },
    "lenovo thinkpad x1 carbon": { pixels: "1920 × 1200", dpi: "170" },
    "hp spectre x360": { pixels: "1920 × 1200", dpi: "188" },
    "asus zenbook 14": { pixels: "2880 × 1800", dpi: "242" },
    // Monitor phổ biến
    "lg ultragear 27 inch": { pixels: "2560 × 1440", dpi: "109" },
    "samsung odyssey g7": { pixels: "2560 × 1440", dpi: "109" },
    "dell u2723qe": { pixels: "3840 × 2160", dpi: "163" },
    // Tablet (iPad)
    "ipad pro 12.9": { pixels: "2732 × 2048", dpi: "264" },
    "ipad pro 11 inch (m2)": { pixels: "2388 × 1668", dpi: "264" },
    "ipad pro 13 inch (m4)": { pixels: "2752 × 2064", dpi: "264" },
    "ipad pro 11 inch (m4)": { pixels: "2420 × 1668", dpi: "264" },
    "ipad pro 13 inch (m5)": { pixels: "2752 × 2064", dpi: "264" },
    "ipad pro 11 inch (m5)": { pixels: "2420 × 1668", dpi: "264" },
    "ipad air 13 inch (m2)": { pixels: "2732 × 2048", dpi: "264" },
    "ipad air 11 inch (m2)": { pixels: "2360 × 1640", dpi: "264" },
    "ipad air 13 inch (m3)": { pixels: "2732 × 2048", dpi: "264" },
    "ipad air 11 inch (m3)": { pixels: "2360 × 1640", dpi: "264" },
    "ipad air 13 inch (m4)": { pixels: "2732 × 2048", dpi: "264" },
    "ipad air 11 inch (m4)": { pixels: "2360 × 1640", dpi: "264" },
    // Tablet (Samsung)
    "samsung galaxy tab s9": { pixels: "2560 × 1600", dpi: "285" },
    "samsung galaxy tab s10 fe": { pixels: "2304 × 1440", dpi: "249" },
    "samsung galaxy tab s10 fe plus": { pixels: "2880 × 1800", dpi: "280" },
    "samsung galaxy tab s11": { pixels: "2560 × 1600", dpi: "274" },
    "samsung galaxy tab s11 ultra": { pixels: "2960 × 1848", dpi: "239" },
    "samsung galaxy tab s10": { pixels: "2560 × 1600", dpi: "274" }, // Giả định tương tự S11
    // Tablet (Xiaomi / Google / Khác)
    "xiaomi pad 7": { pixels: "2880 × 1800", dpi: "309" },
    "xiaomi pad 8": { pixels: "3000 × 1875", dpi: "315" },
    "google pixel tablet 2": { pixels: "2560 × 1600", dpi: "264" },
};
// Hàm tìm kiếm (không phân biệt hoa thường, hỗ trợ viết tắt & tìm một phần tên)
export function findScreenSpec(query) {
    const lowerQuery = query.toLowerCase().trim();
    // 1. Tìm kiếm chính xác hoặc chứa từ khóa (như trước)
    for (const [name, spec] of Object.entries(SCREEN_SPECS)) {
        if (name.includes(lowerQuery) || lowerQuery.includes(name)) {
            return { name, ...spec };
        }
    }
    // 2. Xử lý viết tắt/viết thường đặc biệt (ip16promax, ip17, samsung s24ultra... + iPad/Tablet)
    const normalizedQuery = lowerQuery.replace(/\s+/g, ""); // bỏ khoảng trắng
    for (const [name, spec] of Object.entries(SCREEN_SPECS)) {
        const normalizedName = name.toLowerCase().replace(/\s+/g, "");
        // --- IPHONE ---
        if (normalizedQuery.startsWith("ip")) {
            const numMatch = normalizedQuery.match(/\d+/);
            const num = numMatch ? numMatch[0] : "";
            if (["14", "15", "16", "17", "18"].includes(num)) {
                if (normalizedQuery.includes("promax") || normalizedQuery === "ip" + num || normalizedQuery === num) {
                    const targetName = `iphone ${num} pro max`;
                    if (name === targetName)
                        return { name, ...spec };
                }
            }
        }
        // --- SAMSUNG ---
        if (normalizedQuery.includes("samsung") || normalizedQuery.startsWith("s24") || normalizedQuery.includes("s24")) {
            if (normalizedQuery.includes("s24ultra") || normalizedQuery === "s24ultra" || normalizedQuery === "s24u") {
                if (name === "samsung galaxy s24 ultra")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("s24plus") || normalizedQuery === "s24plus" || normalizedQuery === "s24p") {
                if (name === "samsung galaxy s24 plus")
                    return { name, ...spec };
            }
            if (normalizedQuery === "s24" || normalizedQuery === "samsung s24") {
                if (name === "samsung galaxy s24")
                    return { name, ...spec };
            }
        }
        // --- PIXEL ---
        if (normalizedQuery.includes("pixel") || normalizedQuery.startsWith("p9") || normalizedQuery.startsWith("p8")) {
            if (normalizedQuery.includes("9proxl") || normalizedQuery === "p9proxl" || normalizedQuery === "pixel9proxl") {
                if (name === "google pixel 9 pro xl")
                    return { name, ...spec };
            }
            if (normalizedQuery === "pixel9" || normalizedQuery === "p9" || normalizedQuery === "p9base") {
                if (name === "google pixel 9")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("8pro") || normalizedQuery === "p8pro" || normalizedQuery === "pixel8pro") {
                if (name === "google pixel 8 pro")
                    return { name, ...spec };
            }
            if (normalizedQuery === "pixel8" || normalizedQuery === "p8" || normalizedQuery === "p8base") {
                if (name === "google pixel 8")
                    return { name, ...spec };
            }
        }
        // --- LAPTOP / MONITOR / TABLET ---
        // iPad (M2-M5 Pro/Air)
        if (normalizedQuery.includes("ipad") || normalizedQuery.startsWith("ipd") || normalizedQuery.includes("m2") || normalizedQuery.includes("m3") || normalizedQuery.includes("m4") || normalizedQuery.includes("m5")) {
            // iPad Pro 12.9 (M2)
            if (normalizedQuery.includes("ipad pro 12.9") || normalizedQuery === "ip129" || normalizedQuery === "ipad129") {
                if (name === "ipad pro 12.9")
                    return { name, ...spec };
            }
            // iPad Pro 11 (M2/M4/M5)
            if (normalizedQuery.includes("ipad pro 11") || normalizedQuery === "ip11pro" || normalizedQuery === "ip11m2" || normalizedQuery === "ip11m4" || normalizedQuery === "ip11m5") {
                if (normalizedQuery.includes("m5") || normalizedQuery.includes("2025") || normalizedQuery.includes("2026")) {
                    if (name === "ipad pro 11 inch (m5)")
                        return { name, ...spec };
                }
                else if (normalizedQuery.includes("m4") || normalizedQuery.includes("2024")) {
                    if (name === "ipad pro 11 inch (m4)")
                        return { name, ...spec };
                }
                else if (normalizedQuery.includes("m2") || normalizedQuery.includes("2022")) {
                    if (name === "ipad pro 11 inch (m2)")
                        return { name, ...spec };
                }
            }
            // iPad Pro 13 (M4/M5)
            if (normalizedQuery.includes("ipad pro 13") || normalizedQuery === "ip13pro" || normalizedQuery === "ip13m4" || normalizedQuery === "ip13m5") {
                if (normalizedQuery.includes("m5") || normalizedQuery.includes("2025") || normalizedQuery.includes("2026")) {
                    if (name === "ipad pro 13 inch (m5)")
                        return { name, ...spec };
                }
                else if (normalizedQuery.includes("m4") || normalizedQuery.includes("2024")) {
                    if (name === "ipad pro 13 inch (m4)")
                        return { name, ...spec };
                }
            }
            // iPad Air (M2/M3/M4)
            if (normalizedQuery.includes("ipad air") || normalizedQuery.includes("ia")) {
                if (normalizedQuery.includes("13") || normalizedQuery.includes("13inch")) {
                    if (normalizedQuery.includes("m4") || normalizedQuery.includes("2026")) {
                        if (name === "ipad air 13 inch (m4)")
                            return { name, ...spec };
                    }
                    else if (normalizedQuery.includes("m3") || normalizedQuery.includes("2025")) {
                        if (name === "ipad air 13 inch (m3)")
                            return { name, ...spec };
                    }
                    else if (normalizedQuery.includes("m2") || normalizedQuery.includes("2024")) {
                        if (name === "ipad air 13 inch (m2)")
                            return { name, ...spec };
                    }
                }
                if (normalizedQuery.includes("11") || normalizedQuery.includes("11inch")) {
                    if (normalizedQuery.includes("m4") || normalizedQuery.includes("2026")) {
                        if (name === "ipad air 11 inch (m4)")
                            return { name, ...spec };
                    }
                    else if (normalizedQuery.includes("m3") || normalizedQuery.includes("2025")) {
                        if (name === "ipad air 11 inch (m3)")
                            return { name, ...spec };
                    }
                    else if (normalizedQuery.includes("m2") || normalizedQuery.includes("2024")) {
                        if (name === "ipad air 11 inch (m2)")
                            return { name, ...spec };
                    }
                }
            }
        }
        // Samsung Tablet
        if (normalizedQuery.includes("samsung tab") || normalizedQuery.includes("sts") || normalizedQuery.includes("tab s")) {
            if (normalizedQuery.includes("s11ultra") || normalizedQuery === "sts11u" || normalizedQuery === "tabs11u") {
                if (name === "samsung galaxy tab s11 ultra")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("s11") || normalizedQuery === "sts11" || normalizedQuery === "tabs11") {
                if (name === "samsung galaxy tab s11")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("s10feplus") || normalizedQuery === "sts10fep" || normalizedQuery === "tabs10fep") {
                if (name === "samsung galaxy tab s10 fe plus")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("s10fe") || normalizedQuery === "sts10fe" || normalizedQuery === "tabs10fe") {
                if (name === "samsung galaxy tab s10 fe")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("s10") || normalizedQuery === "sts10" || normalizedQuery === "tabs10") {
                if (name === "samsung galaxy tab s10")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("s9") || normalizedQuery === "sts9" || normalizedQuery === "tabs9") {
                if (name === "samsung galaxy tab s9")
                    return { name, ...spec };
            }
        }
        // Xiaomi Pad
        if (normalizedQuery.includes("xiaomi pad") || normalizedQuery.includes("xp")) {
            if (normalizedQuery.includes("7") || normalizedQuery === "xp7") {
                if (name === "xiaomi pad 7")
                    return { name, ...spec };
            }
            if (normalizedQuery.includes("8") || normalizedQuery === "xp8") {
                if (name === "xiaomi pad 8")
                    return { name, ...spec };
            }
        }
        // Google Pixel Tablet
        if (normalizedQuery.includes("pixel tablet") || normalizedQuery.includes("gpt") || normalizedQuery.includes("pixel tablet 2")) {
            if (normalizedQuery.includes("2") || normalizedQuery === "gpt2") {
                if (name === "google pixel tablet 2")
                    return { name, ...spec };
            }
        }
        // Laptop / Monitor (Giữ nguyên)
        if (normalizedQuery.includes("macbook") || normalizedQuery.includes("mbp")) {
            if (normalizedQuery.includes("14") && name === "macbook pro 14 inch")
                return { name, ...spec };
            if (normalizedQuery.includes("16") && name === "macbook pro 16 inch")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("dell xps 13") || normalizedQuery === "dx13") {
            if (name === "dell xps 13")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("thinkpad x1") || normalizedQuery === "tpx1") {
            if (name === "lenovo thinkpad x1 carbon")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("hp spectre") || normalizedQuery === "hps") {
            if (name === "hp spectre x360")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("asus zenbook") || normalizedQuery === "az14") {
            if (name === "asus zenbook 14")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("lg 27") || normalizedQuery === "lg27") {
            if (name === "lg ultragear 27 inch")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("samsung g7") || normalizedQuery === "sg7") {
            if (name === "samsung odyssey g7")
                return { name, ...spec };
        }
        if (normalizedQuery.includes("dell u27") || normalizedQuery === "du27") {
            if (name === "dell u2723qe")
                return { name, ...spec };
        }
    }
    return null;
}
//# sourceMappingURL=screenSpecs.js.map