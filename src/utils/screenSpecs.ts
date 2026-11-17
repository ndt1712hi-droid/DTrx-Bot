// Dữ liệu cấu hình màn hình (Pixels & DPI)
// Định dạng: "tên dòng máy": { pixels: "W x H", dpi?: "số" }
// Lưu ý: Với iPhone 14-18 Pro Max, chỉ cần gửi pixels (không có dpi)

export const SCREEN_SPECS: Record<string, { pixels: string; dpi?: string }> = {
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

	// Tablet
	"ipad pro 12.9": { pixels: "2732 × 2048", dpi: "264" },
	"samsung galaxy tab s9": { pixels: "2560 × 1600", dpi: "285" },
};

// Hàm tìm kiếm (không phân biệt hoa thường, hỗ trợ viết tắt & tìm một phần tên)
export function findScreenSpec(query: string): { name: string; pixels: string; dpi?: string } | null {
	const lowerQuery = query.toLowerCase().trim();
	
	// 1. Tìm kiếm chính xác hoặc chứa từ khóa (như trước)
	for (const [name, spec] of Object.entries(SCREEN_SPECS)) {
		if (name.includes(lowerQuery) || lowerQuery.includes(name)) {
			return { name, ...spec };
		}
	}

	// 2. Xử lý viết tắt/viết thường đặc biệt (ip16promax, ip17, samsung s24ultra...)
	const normalizedQuery = lowerQuery.replace(/\s+/g, ""); // bỏ khoảng trắng
	
	for (const [name, spec] of Object.entries(SCREEN_SPECS)) {
		const normalizedName = name.toLowerCase().replace(/\s+/g, "");
		
		// --- IPHONE ---
		// ip14promax, ip15promax, ip16promax, ip17promax, ip18promax
		// ip17, ip16, ip15, ip14 (mặc định Pro Max theo yêu cầu)
		if (normalizedQuery.startsWith("ip")) {
			const numMatch = normalizedQuery.match(/\d+/);
			const num = numMatch ? numMatch[0] : "";
			
			// Kiểm tra iPhone Pro Max (14-18)
			if (["14", "15", "16", "17", "18"].includes(num)) {
				// Kiểm tra nếu có "promax" hoặc chỉ số (ip16 -> iphone 16 pro max)
				if (normalizedQuery.includes("promax") || normalizedQuery === "ip" + num || normalizedQuery === num) {
					const targetName = `iphone ${num} pro max`;
					if (name === targetName) return { name, ...spec };
				}
			}
		}

		// --- SAMSUNG ---
		// samsung s24ultra, s24, s24plus, s24u, s24p
		if (normalizedQuery.includes("samsung") || normalizedQuery.startsWith("s24") || normalizedQuery.includes("s24")) {
			if (normalizedQuery.includes("s24ultra") || normalizedQuery === "s24ultra" || normalizedQuery === "s24u") {
				if (name === "samsung galaxy s24 ultra") return { name, ...spec };
			}
			if (normalizedQuery.includes("s24plus") || normalizedQuery === "s24plus" || normalizedQuery === "s24p") {
				if (name === "samsung galaxy s24 plus") return { name, ...spec };
			}
			if (normalizedQuery === "s24" || normalizedQuery === "samsung s24") {
				if (name === "samsung galaxy s24") return { name, ...spec };
			}
		}

		// --- PIXEL ---
		// pixel 9, pixel 9 pro xl, p9, p9proxl, pixel 8, p8...
		if (normalizedQuery.includes("pixel") || normalizedQuery.startsWith("p9") || normalizedQuery.startsWith("p8")) {
			if (normalizedQuery.includes("9proxl") || normalizedQuery === "p9proxl" || normalizedQuery === "pixel9proxl") {
				if (name === "google pixel 9 pro xl") return { name, ...spec };
			}
			if (normalizedQuery === "pixel9" || normalizedQuery === "p9" || normalizedQuery === "p9base") {
				if (name === "google pixel 9") return { name, ...spec };
			}
			if (normalizedQuery.includes("8pro") || normalizedQuery === "p8pro" || normalizedQuery === "pixel8pro") {
				if (name === "google pixel 8 pro") return { name, ...spec };
			}
			if (normalizedQuery === "pixel8" || normalizedQuery === "p8" || normalizedQuery === "p8base") {
				if (name === "google pixel 8") return { name, ...spec };
			}
		}

		// --- LAPTOP / MONITOR / TABLET ---
		// mbp14, mbp16, dx13, tpx1, hps, az14, lg27, sg7, du27, ip129, sts9
		if (normalizedQuery.includes("macbook") || normalizedQuery.includes("mbp")) {
			if (normalizedQuery.includes("14") && name === "macbook pro 14 inch") return { name, ...spec };
			if (normalizedQuery.includes("16") && name === "macbook pro 16 inch") return { name, ...spec };
		}
		if (normalizedQuery.includes("dell xps 13") || normalizedQuery === "dx13") {
			if (name === "dell xps 13") return { name, ...spec };
		}
		if (normalizedQuery.includes("thinkpad x1") || normalizedQuery === "tpx1") {
			if (name === "lenovo thinkpad x1 carbon") return { name, ...spec };
		}
		if (normalizedQuery.includes("hp spectre") || normalizedQuery === "hps") {
			if (name === "hp spectre x360") return { name, ...spec };
		}
		if (normalizedQuery.includes("asus zenbook") || normalizedQuery === "az14") {
			if (name === "asus zenbook 14") return { name, ...spec };
		}
		if (normalizedQuery.includes("lg 27") || normalizedQuery === "lg27") {
			if (name === "lg ultragear 27 inch") return { name, ...spec };
		}
		if (normalizedQuery.includes("samsung g7") || normalizedQuery === "sg7") {
			if (name === "samsung odyssey g7") return { name, ...spec };
		}
		if (normalizedQuery.includes("dell u27") || normalizedQuery === "du27") {
			if (name === "dell u2723qe") return { name, ...spec };
		}
		if (normalizedQuery.includes("ipad pro 12.9") || normalizedQuery === "ip129") {
			if (name === "ipad pro 12.9") return { name, ...spec };
		}
		if (normalizedQuery.includes("samsung tab s9") || normalizedQuery === "sts9") {
			if (name === "samsung galaxy tab s9") return { name, ...spec };
		}
	}

	return null;
}
