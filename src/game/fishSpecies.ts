import type { FishSpecies } from '../types/fishing'

export const FISH_SPECIES: readonly FishSpecies[] = [
  {
    id: 'balanced-koi',
    name: '均衡锦鲤',
    description: '不赶时间，也不浪费时间。它总在刚刚好的节奏里游动。',
    pattern: 'balanced',
    difficulty: 'easy',
    reactionWindowMs: 1_650,
    minLength: 18,
    maxLength: 34,
    bodyColor: '#e9a85e',
    accentColor: '#fff0c9',
  },
  {
    id: 'deadline-eel',
    name: '截止日期鳗鱼',
    description: '它不知道截止日期是哪天，只知道一定是今晚。',
    pattern: 'burst',
    difficulty: 'hard',
    reactionWindowMs: 760,
    minLength: 32,
    maxLength: 58,
    bodyColor: '#7b77bd',
    accentColor: '#d9d4ff',
  },
  {
    id: 'moonfin',
    name: '月鳍鱼',
    description: '只在屏幕光比月光更亮的夜晚靠近河岸。',
    pattern: 'night',
    difficulty: 'medium',
    reactionWindowMs: 1_080,
    minLength: 14,
    maxLength: 27,
    bodyColor: '#72aadd',
    accentColor: '#dff5ff',
  },
  {
    id: 'reset-salmon',
    name: '重置鲑鱼',
    description: '它沿着倒计时逆流而上，总在额度重置前突然出现。',
    pattern: 'resetRush',
    difficulty: 'hard',
    reactionWindowMs: 820,
    minLength: 24,
    maxLength: 43,
    bodyColor: '#e27d79',
    accentColor: '#ffe3c8',
  },
]

export const difficultyLabel = (difficulty: FishSpecies['difficulty']) => (
  difficulty === 'easy' ? '容易' : difficulty === 'medium' ? '普通' : '困难'
)
