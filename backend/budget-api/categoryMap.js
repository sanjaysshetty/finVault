"use strict";

// Maps granular SpendingDash categories → budget rollup categories.
// This is a READ-ONLY computation layer — stored data is never modified.
// SpendingDash continues to show the granular categories unchanged.
const CATEGORY_MAP = {
  // Groceries
  "Pantry & Snacks":     "Groceries",
  "Produce":             "Groceries",
  "Dairy":               "Groceries",
  "Meat & Seafood":      "Groceries",
  "Beverages":           "Groceries",
  "Bakery":              "Groceries",
  "Frozen":              "Groceries",
  "Deli":                "Groceries",
  "Prepared Foods":      "Groceries",

  // Dining
  "Dining & Restaurant": "Dining Out",

  // Health
  "Health & Medicine":   "Healthcare",
  "Pharmacy":            "Healthcare",

  // Home
  "Household":           "Household",

  // Personal
  "Personal Care":       "Personal",

  // Tax rows are excluded from budget totals
  "Tax":                 "_TAX",

  // Receipt-level summary rows — excluded to avoid double-counting line items
  "SUMMARY":             "_SUMMARY",

  // Default fallback
  "Uncategorized":       "Other",
};

// All valid budget categories in display order.
const BUDGET_CATEGORIES = [
  { key: "Groceries",   label: "Groceries",   countsAsSavingsDefault: false },
  { key: "Dining Out",  label: "Dining Out",  countsAsSavingsDefault: false },
  { key: "Housing",     label: "Housing",     countsAsSavingsDefault: false },
  { key: "Transport",   label: "Transportation", countsAsSavingsDefault: false },
  { key: "Utilities",   label: "Utilities",   countsAsSavingsDefault: false },
  { key: "Healthcare",  label: "Healthcare",  countsAsSavingsDefault: false },
  { key: "Personal",    label: "Personal Care", countsAsSavingsDefault: false },
  { key: "Household",   label: "Household",   countsAsSavingsDefault: false },
  { key: "Investments", label: "Investments", countsAsSavingsDefault: true  },
  { key: "Education",   label: "Education",   countsAsSavingsDefault: false },
  { key: "Entertainment", label: "Entertainment", countsAsSavingsDefault: false },
  { key: "Other",       label: "Other",       countsAsSavingsDefault: false },
];

// Manual outflows carry a budgetCategory field directly — they bypass the map.
// Receipt/CC items use this function to find their rollup bucket.
function toBudgetCategory(spendingCategory) {
  if (!spendingCategory) return "Other";
  return CATEGORY_MAP[spendingCategory] || "Other";
}

// Returns true if this item should be excluded from budget totals.
function isExcluded(budgetCategory) {
  return budgetCategory === "_TAX" || budgetCategory === "_SUMMARY";
}

module.exports = { CATEGORY_MAP, BUDGET_CATEGORIES, toBudgetCategory, isExcluded };
