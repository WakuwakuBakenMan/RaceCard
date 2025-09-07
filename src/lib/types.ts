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
};

export type RaceDay = {
  date: string; // YYYY-MM-DD
  meetings: Meeting[];
};
