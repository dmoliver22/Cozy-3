// Things you can buy from the salon catalogue between (or during) appointments.
export const UPGRADES = [
  { id: 'jet', kind: 'tool', name: 'Rain-shower head', desc: 'A wider, softer spray that rinses 70% faster and never stings eyes.', cost: 60 },
  { id: 'bubbly', kind: 'tool', name: 'Bubble Bliss shampoo', desc: 'Lathers 60% faster, with extra bubbles to pop.', cost: 50 },
  { id: 'turbo', kind: 'tool', name: 'Turbo dryer motor', desc: '1.7× the airflow. Coats dry in about half the time.', cost: 90 },
  { id: 'cloud', kind: 'tool', name: 'Cloud-maker diffuser', desc: 'Blow-dried fur puffs up even bigger. Owners adore it.', cost: 140 },
  { id: 'detangler', kind: 'tool', name: 'Detangler slicker', desc: 'Brushes out mats twice as fast.', cost: 70 },
  { id: 'whisper', kind: 'tool', name: 'Whisper clippers', desc: 'A 30% wider blade for smoother passes.', cost: 80 },
  { id: 'treats', kind: 'salon', name: 'Gourmet treats', desc: 'Liver biscuits. Treats and pets make dogs much happier.', cost: 35 },
  { id: 'plant', kind: 'salon', name: 'Monstera', desc: 'A leafy friend by the window that rustles in the dryer breeze. +5% tips.', cost: 40, cozy: 0.05 },
  { id: 'rug', kind: 'salon', name: 'Rainbow rug', desc: 'Soft under paws and boots. +5% tips.', cost: 50, cozy: 0.05 },
  { id: 'frames', kind: 'salon', name: 'Bigger Wall of Fluff', desc: 'Room for 12 photos on the wall. +4% tips.', cost: 45, cozy: 0.04 },
  { id: 'radio', kind: 'salon', name: 'Salon radio', desc: 'Lo-fi for good dogs. +8% tips.', cost: 60, cozy: 0.08 },
  { id: 'lights', kind: 'salon', name: 'Fairy lights', desc: 'A twinkly string that sways when the dryer passes. +8% tips.', cost: 70, cozy: 0.08 },
];

export function cozyBonus(owned) {
  let b = 0;
  for (const u of UPGRADES) if (owned[u.id] && u.cozy) b += u.cozy;
  return b;
}
