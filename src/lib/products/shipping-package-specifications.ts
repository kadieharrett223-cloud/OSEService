import { canonicalSkuKey } from "./canonical-sku";
import type { PackageDimensions } from "./package-dimensions";

// Kadie's shipping list, 2026-11-27, in inches and pounds. Missing weights stay unknown.
// 2PCFHD-15: Kadie confirmed 2,215 lb TOTAL including its 190 lb crate;
// the main bundle's 2,025 lb is the remainder, not an additional 2,215 lb.
// AS800 support structure: 260 lb is combined for BOTH crates.
// 4032XL specifications do not identify or merge the separate 4P-4032XL product.
export const SHIPPING_PACKAGE_SPECIFICATIONS: Record<string, PackageDimensions> = {
  "2PBP-8": {
    "lengthInches": 112,
    "widthInches": 18,
    "heightInches": 37.92,
    "weightPounds": 1400
  },
  "2PCF-9": {
    "lengthInches": 112,
    "widthInches": 18,
    "heightInches": 37,
    "weightPounds": 1400
  },
  "2PCFXL-10": {
    "lengthInches": 112,
    "widthInches": 18,
    "heightInches": 38,
    "weightPounds": 1595
  },
  "2PDDA-10": {
    "lengthInches": 129,
    "widthInches": 18,
    "heightInches": 38,
    "weightPounds": 1565
  },
  "2PBP-10": {
    "lengthInches": 112,
    "widthInches": 18,
    "heightInches": 38,
    "weightPounds": 1380
  },
  "2PBPXW-10": {
    "lengthInches": 112,
    "widthInches": 18,
    "heightInches": 38,
    "weightPounds": 1380
  },
  "2PBP-12": {
    "lengthInches": 116,
    "widthInches": 21,
    "heightInches": 43,
    "weightPounds": 1830
  },
  "2PCFHD-12": {
    "lengthInches": 116,
    "widthInches": 21,
    "heightInches": 43,
    "weightPounds": 2085
  },
  "HDMBL-9": {
    "lengthInches": 166,
    "widthInches": 22,
    "heightInches": 30,
    "weightPounds": 1945
  },
  "4PML-9": {
    "lengthInches": 165,
    "widthInches": 20,
    "heightInches": 28,
    "weightPounds": 1905
  },
  "4PHR-9X": {
    "lengthInches": 185,
    "widthInches": 21,
    "heightInches": 29,
    "weightPounds": 1995
  },
  "4PC-6": {
    "lengthInches": 154,
    "widthInches": 22,
    "heightInches": 24,
    "weightPounds": 1215
  },
  "4PXL-10": {
    "lengthInches": 213,
    "widthInches": 24,
    "heightInches": 29,
    "weightPounds": 2215
  },
  "4PXL-10B": {
    "lengthInches": 216,
    "widthInches": 24,
    "heightInches": 35,
    "weightPounds": 3200
  },
  "4PXLA-10": {
    "lengthInches": 222,
    "widthInches": 24,
    "heightInches": 35,
    "weightPounds": 3200
  },
  "4PXW-10": {
    "lengthInches": 204,
    "widthInches": 21,
    "heightInches": 40,
    "weightPounds": 2715
  },
  "4PHDXLA-11": {
    "lengthInches": 193,
    "widthInches": 28,
    "heightInches": 44,
    "weightPounds": 3385
  },
  "4PHDXL-12": {
    "lengthInches": 224,
    "widthInches": 24,
    "heightInches": 35,
    "weightPounds": 2980
  },
  "4PHDXLA-12": {
    "lengthInches": 224,
    "widthInches": 24,
    "heightInches": 35,
    "weightPounds": 3285
  },
  "4PHDXLA-14": {
    "lengthInches": 198,
    "widthInches": 26,
    "heightInches": 40,
    "weightPounds": 4000
  },
  "4PHDXLA-15": {
    "lengthInches": 233,
    "widthInches": 28,
    "heightInches": 44,
    "weightPounds": 4260
  },
  "4032S": {
    "lengthInches": 200,
    "widthInches": 26,
    "heightInches": 36,
    "weightPounds": 3685
  },
  "YZ-R-30": {
    "lengthInches": 29,
    "widthInches": 61,
    "heightInches": 17,
    "weightPounds": 425
  },
  "YZ-R-45": {
    "lengthInches": 30,
    "widthInches": 60,
    "heightInches": 18,
    "weightPounds": 577
  },
  "HDML-1": {
    "lengthInches": 79,
    "widthInches": 28,
    "heightInches": 10,
    "weightPounds": null
  },
  "HDML-15": {
    "lengthInches": 35,
    "widthInches": 87,
    "heightInches": 14,
    "weightPounds": 478
  },
  "MRSL-75": {
    "lengthInches": 62,
    "widthInches": 76,
    "heightInches": 28,
    "weightPounds": 1310
  },
  "FRSL-78": {
    "lengthInches": 28,
    "widthInches": 64,
    "heightInches": 32,
    "weightPounds": 1850
  },
  "MRSL-6": {
    "lengthInches": 41,
    "widthInches": 86,
    "heightInches": 20,
    "weightPounds": 1000
  },
  "T650": {
    "lengthInches": 39,
    "widthInches": 47,
    "heightInches": 49,
    "weightPounds": 810
  },
  "T620": {
    "lengthInches": 30,
    "widthInches": 39,
    "heightInches": 34,
    "weightPounds": 420
  },
  "W690": {
    "lengthInches": 40,
    "widthInches": 46,
    "heightInches": 46,
    "weightPounds": 555
  },
  "W820": {
    "lengthInches": 30,
    "widthInches": 39,
    "heightInches": 46,
    "weightPounds": 255
  },
  "W810": {
    "lengthInches": 30,
    "widthInches": 38,
    "heightInches": 45,
    "weightPounds": 265
  },
  "L-ACB-1": {
    "lengthInches": 84,
    "widthInches": 19,
    "heightInches": 7,
    "weightPounds": 125
  },
  "YZRCJ-35AP": {
    "lengthInches": 23,
    "widthInches": 38,
    "heightInches": 12,
    "weightPounds": 240
  },
  "YZRCJ-35HP": {
    "lengthInches": 23,
    "widthInches": 38,
    "heightInches": 12,
    "weightPounds": 240
  },
  "HLCJ-6": {
    "lengthInches": 25,
    "widthInches": 38,
    "heightInches": 13,
    "weightPounds": 315
  },
  "FBCJ-6": {
    "lengthInches": 24,
    "widthInches": 40,
    "heightInches": 11,
    "weightPounds": 315
  },
  "JVCJ-6": {
    "lengthInches": 27,
    "widthInches": 36,
    "heightInches": 14,
    "weightPounds": null
  },
  "YZRCJ-7": {
    "lengthInches": 26,
    "widthInches": 41,
    "heightInches": 15,
    "weightPounds": 365
  },
  "YZSCJ-7": {
    "lengthInches": 24,
    "widthInches": 42,
    "heightInches": 12,
    "weightPounds": null
  },
  "HLCJ-14": {
    "lengthInches": 25,
    "widthInches": 40,
    "heightInches": 16,
    "weightPounds": 300
  },
  "HOC2": {
    "lengthInches": 50,
    "widthInches": 4,
    "heightInches": 4,
    "weightPounds": 40
  },
  "HOC4": {
    "lengthInches": 50,
    "widthInches": 4,
    "heightInches": 4,
    "weightPounds": 40
  },
  "4PTA-3": {
    "lengthInches": 32,
    "widthInches": 8,
    "heightInches": 8,
    "weightPounds": 11
  },
  "4PTA-6": {
    "lengthInches": 12,
    "widthInches": 9,
    "heightInches": 6,
    "weightPounds": 15
  },
  "HPU1103": {
    "lengthInches": 31,
    "widthInches": 10,
    "heightInches": 12,
    "weightPounds": 55
  },
  "HPU2203": {
    "lengthInches": 31,
    "widthInches": 10,
    "heightInches": 12,
    "weightPounds": 55
  },
  "HPU2204": {
    "lengthInches": 31,
    "widthInches": 10,
    "heightInches": 12,
    "weightPounds": 55
  },
  "OD-A30": {
    "lengthInches": 18,
    "widthInches": 19,
    "heightInches": 23,
    "weightPounds": 12
  },
  "OD-7170": {
    "lengthInches": 31,
    "widthInches": 18,
    "heightInches": 19,
    "weightPounds": 15
  },
  "OD-3198A": {
    "lengthInches": 18,
    "widthInches": 20,
    "heightInches": 37,
    "weightPounds": 42
  },
  "OD-3198": {
    "lengthInches": 18,
    "widthInches": 20,
    "heightInches": 37,
    "weightPounds": 42
  },
  "APU": {
    "lengthInches": 27,
    "widthInches": 16,
    "heightInches": 10,
    "weightPounds": null
  },
  "UHS-5075": {
    "lengthInches": 55,
    "widthInches": 15,
    "heightInches": 4,
    "weightPounds": 35
  },
  "UHJS-750": {
    "lengthInches": 55,
    "widthInches": 15,
    "heightInches": 4,
    "weightPounds": 35
  },
  "TJ1101A": {
    "lengthInches": 43,
    "widthInches": 12,
    "heightInches": 8,
    "weightPounds": 82
  },
  "TJ1102": {
    "lengthInches": 19,
    "widthInches": 12,
    "heightInches": 29,
    "weightPounds": 125
  },
  "2PCFHD-15": {
    "lengthInches": null,
    "widthInches": null,
    "heightInches": null,
    "weightPounds": 2215,
    "packages": [
      {
        "label": "Main bundle",
        "quantity": 1,
        "lengthInches": 132,
        "widthInches": 21,
        "heightInches": 39,
        "totalWeightPounds": 2025
      },
      {
        "label": "Column crate",
        "quantity": 1,
        "lengthInches": 18,
        "widthInches": 27,
        "heightInches": 15,
        "totalWeightPounds": 190
      }
    ]
  },
  "4032XL": {
    "lengthInches": null,
    "widthInches": null,
    "heightInches": null,
    "weightPounds": 5380,
    "packages": [
      {
        "label": "First bundle",
        "quantity": 1,
        "lengthInches": 203,
        "widthInches": 22,
        "heightInches": 28,
        "totalWeightPounds": 2880
      },
      {
        "label": "Second bundle",
        "quantity": 1,
        "lengthInches": 192,
        "widthInches": 23,
        "heightInches": 28,
        "totalWeightPounds": 2500
      }
    ]
  },
  "T-999E": {
    "lengthInches": null,
    "widthInches": null,
    "heightInches": null,
    "weightPounds": 1075,
    "packages": [
      {
        "label": "Main body",
        "quantity": 1,
        "lengthInches": 36,
        "widthInches": 45,
        "heightInches": 41,
        "totalWeightPounds": 690
      },
      {
        "label": "Motor",
        "quantity": 1,
        "lengthInches": 25,
        "widthInches": 28,
        "heightInches": 17,
        "totalWeightPounds": 215
      },
      {
        "label": "Arm",
        "quantity": 1,
        "lengthInches": 44,
        "widthInches": 18,
        "heightInches": 14,
        "totalWeightPounds": 170
      }
    ]
  },
  "AS800": {
    "lengthInches": null,
    "widthInches": null,
    "heightInches": null,
    "weightPounds": 710,
    "packages": [
      {
        "label": "Main body",
        "quantity": 1,
        "lengthInches": 30,
        "widthInches": 54,
        "heightInches": 39,
        "totalWeightPounds": 450
      },
      {
        "label": "Support structure",
        "quantity": 2,
        "lengthInches": 111,
        "widthInches": 11,
        "heightInches": 14,
        "totalWeightPounds": 260
      }
    ]
  }
};

const specificationsByKey = Object.fromEntries(Object.entries(SHIPPING_PACKAGE_SPECIFICATIONS)
  .map(([sku, dimensions]) => [canonicalSkuKey(sku), dimensions]));

export function getShippingPackageSpecification(sku: string | null | undefined) {
  return specificationsByKey[canonicalSkuKey(sku)] ?? null;
}
