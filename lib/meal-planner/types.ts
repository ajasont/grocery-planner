// --- Input to the planner (built by lib/meal-planner/inputs.ts) ---

export type PlannerDeal = {
  canonical_id: string;
  canonical_name: string;
  category: string | null;
  cheapest_retailer: string;   // slug, e.g. 'harris-teeter'
  sale_price: number;
};

export type PlannerPantryItem = {
  canonical_id: string;
  canonical_name: string;
};

export type PlannerPreferences = {
  dietary_flags: string[];
  disliked_ingredients: string[];
  liked_ingredients: string[];
  disliked_cuisines: string[];
  liked_cuisines: string[];
};

export type PlannerInput = {
  deals: PlannerDeal[];
  pantry: PlannerPantryItem[];
  preferences: PlannerPreferences;
  prior_meal_names: string[];
};

// --- Output from the model (validated by lib/meal-planner/validator.ts) ---

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type Day =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type GeneratedMealIngredient = {
  canonical_id: string;
  quantity: number | null;
  unit: string | null;
};

export type GeneratedMeal = {
  day: Day;
  meal_type: MealType;
  name: string;
  cuisine: string | null;
  cook_time_minutes: number | null;
  servings: number | null;
  ingredients: GeneratedMealIngredient[];
  notes: string | null;
};

export type GeneratedPlan = {
  meals: GeneratedMeal[];
};

// --- Renderable plan (returned by lib/meal-planner/read.ts) ---

export type RenderableMealIngredient = {
  canonical_id: string;
  canonical_name: string;
  quantity: number | null;
  unit: string | null;
};

export type RenderableMeal = {
  id: number;
  meal_type: MealType;
  name: string;
  cuisine: string | null;
  cook_time_minutes: number | null;
  servings: number | null;
  notes: string | null;
  ingredients: RenderableMealIngredient[];
};

export type RenderableDay = {
  day: Day;
  breakfast: RenderableMeal | null;
  lunch: RenderableMeal | null;
  dinner: RenderableMeal | null;
};

export type RenderablePlan = {
  id: number;
  week_of: string;
  days: RenderableDay[]; // ordered monday → sunday
  snacks: RenderableMeal[];
};

// --- Errors thrown by the pipeline ---

export class AnthropicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicError';
  }
}
export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}
export class ValidationError extends Error {
  constructor(
    message: string,
    public kind: 'schema' | 'sanity'
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
export class VarietyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarietyError';
  }
}
