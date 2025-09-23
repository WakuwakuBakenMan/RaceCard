// 日本語UI/コメント。識別子は英語。
export type Horse = {
  num: number;
  draw: number;
  name: string;
  sex: string;
  age: number;
  weight: number;
  jockey: string;
  trainer: string;
  odds?: number;
  popularity?: number;
  pace_type?: Array<'A' | 'B' | 'C'>;
};

export type Race = {
  no: number;
  name: string;
  distance_m: number;
  ground: string;
  course_note?: string;
  condition?: string;
  start_time?: string;
  pace_score?: number;
  pace_mark?: string;
  horses: Horse[];
};

export type Meeting = {
  track: string; // 例: 新潟、札幌
  kaiji: number; // 何回開催
  nichiji: number; // 何日目
  races: Race[];
  // 開催×馬場ごとのポジションバイアス（任意）
  position_bias?: Record<string, PositionBiasForGround>;
};

export type RaceDay = {
  date: string; // YYYY-MM-DD
  meetings: Meeting[];
};

// --- Position Bias types ---
export type PaceBiasTarget = 'A' | 'B' | 'C' | null; // 脚質
export type DrawBiasTarget = 'inner' | 'outer' | null; // 枠 内/外

export type PaceBiasStat = {
  target: PaceBiasTarget; // 閾値未達/サンプル不足は null
  ratio?: number; // 0..1（任意）
  n_total?: number; // サンプル数（任意）
};

export type DrawBiasStat = {
  target: DrawBiasTarget; // 閾値未達/サンプル不足は null
  ratio?: number; // 0..1（任意）
  n_total?: number; // サンプル数（任意）
};

export type PositionBiasForGround = {
  pace: {
    win_place?: PaceBiasStat; // 複勝圏
    quinella?: PaceBiasStat;  // 連対圏
    longshot?: PaceBiasStat;  // 穴好走（n>=6のみ）
  };
  draw?: DrawBiasStat; // 枠（内/外）
};
