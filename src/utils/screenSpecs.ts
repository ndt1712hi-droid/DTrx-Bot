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

// Hàm tìm kiếm (không phân biệt hoa thường, hỗ trợ tìm một phần tên)
export function findScreenSpec(query: string): { name: string; pixels: string; dpi?: string } | null {
	const lowerQuery = query.toLowerCase().trim();
	
	// Tìm kiếm chính xác hoặc chứa từ khóa
	for (const [name, spec] of Object.entries(SCREEN_SPECS)) {
		if (name.includes(lowerQuery) || lowerQuery.includes(name)) {
			return { name, ...spec };
		}
	}
	return null;
}
