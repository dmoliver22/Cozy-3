# Suds & Snips

*Matted, muddy and miserable goes in. A fluffball comes out.*

A cozy first-person dog grooming salon that runs in the browser. Soak and lather a muddy dog until the
runoff runs clear, blow-dry it into a cloud, brush out the mats, clip the cut the owner asked for, tie a
bow, then snap a polaroid for the Wall of Fluff and get paid.

Every bit of motion is simulated rather than keyframed:

| What moves | How |
| --- | --- |
| Fur | 1,000–1,500 strands per dog, each a chain of verlet particles rooted on the skeleton. Strands are pulled toward a groomed rest shape whose stiffness and "stand-out" depend on how wet, muddy, matted and blow-dried they are, so a soaked coat clings and drips and a dried one springs up into volume. |
| Hair types | **Fluffy** and **curly** coats are clouds of puffs. **Silky** coats (golden retriever, shih tzu) are long, wavy, glossy locks drawn as continuous ribbons that flow, cling when wet and shine when brushed. **Wiry** coats (schnauzer) are stiff bristles with a beard, eyebrows and leg furnishings. **Double** coats (husky, corgi) stand off the body over an undercoat you blow out with the dryer and brush out in drifting clumps. |
| The dog | Torso and head are rigid bodies held up by PD "muscles"; the neck is a spring joint. Legs are verlet knees with IK, and paws plant and step on their own when the body moves, so walking, turning and the proud shake are all physical. Jumps are real ballistic leaps whose height is worked out so the folded paws clear the tub rim or table edge; to get out of the tub the dog puts its front paws up on the rim first. Tail and ears are verlet chains; wagging drives the tail's rest pose and the hips wiggle along. |
| Water | Ballistic droplets that soak and rinse the fur they touch, pick up mud, trickle down the coat and tint the runoff in the tub. |
| Bubbles, clippings | Bubbles cling to lather then float on buoyancy and dryer wind and pop. Clipped tufts flutter down with heavy drag, pile up, and scatter when the dryer catches them. |
| The salon | The towel is a cloth sim; the hoses are verlet ropes plugged into the grip of the sprayer and dryer that drape over the tub rim and rest on the floor; lamps, the door bell and every polaroid swing on pendulums, fairy lights sag and sway, the door closes on a damped spring, coins bounce into the tip jar. |
| Even the UI | Tools sway and reach on springs, toasts and the hotbar bounce, tickets drop in. |

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` makes a static site in `dist/`. `npm run build:single` writes a single HTML file to
`dist-single/` that loads three.js from jsDelivr, handy for sharing.

### Controls

| Input | Action |
| --- | --- |
| Mouse | Look and aim (click the view to capture the mouse; right-drag looks when it is not captured) |
| Left click | Use the tool |
| 1–8 or wheel | Pick a tool: hands, sprayer, shampoo, dryer, slicker brush, clippers, bow, camera |
| R or right-click | Tool option: jet/shower, scent, dryer power, clipper guard #1–#5, ribbon colour |
| WASD, C | Walk, crouch |
| Q / E | Turn the dog |
| F | Interact (treat jar, catalogue, bell, radio) and take the next step |
| B | Salon catalogue (upgrades) |
| Esc | Tea break |

### On a phone or tablet

| Touch | Action |
| --- | --- |
| Drag the tool in hand | Pick up the sprayer, dryer, brush… and move it. It aims at the little reticle just above your fingertip, so your finger never covers the dog: hold to spray or dry, rub to scrub, stroke to brush, sweep to clip. Drag the bow onto the head and let go to tie it. Drag to a screen edge to turn the view |
| Drag anywhere else | Look around (a second finger can look while the first one holds a tool) |
| Tool bar | Pick a tool |
| Tool label | Tap it for the tool option (jet/shower, guard, ribbon colour…) |
| Turn buttons, crouch button | Turn the dog, crouch for bellies and paws |
| Stick | Walk (optional: the view glides to the tub, table and lobby by itself) |
| Tap things | Treat jar, service bell, radio, catalogue; the coin chip opens the catalogue too. With the camera out, tap anywhere to take the photo |

Phones get a lighter quality tier (fewer but puffier fur strands, smaller shadows, less rain), the
render resolution adapts to keep the frame rate up, and Android phones buzz on clips, mats and photos.

### The loop

1. **Check in.** The owner walks in out of the rain with a request: cut, bow colour, temperament.
2. **Bath.** Soak the coat, squirt shampoo, scrub it into lather with your hands (bubbles!), then rinse
   until the water in the tub runs clear. Plain water only shifts the loose mud.
3. **Groom.** On the table: blow-dry (fur puffs up as it dries), brush out mats (they glow orange while
   the brush is out), blow and brush the loose undercoat out of double coats (it glows lilac), clip with
   the right guard (fur that still needs trimming glows pink), tie the bow.
4. **Hand back.** Take the photo. The polaroid flies to the Wall of Fluff, the dog hops down and shakes
   proudly, the owner pays and tips by the star rating. Spend it on tools and salon upgrades.

Nine breeds across five hair types (Old English Sheepdog, Standard Poodle, Pembroke Corgi, Pomeranian,
Golden Retriever, Bichon Frise, Shih Tzu, Miniature Schnauzer, Siberian Husky) and nine cuts (Bath &
Fluff, Puppy, Teddy Bear, Lion, Summer Shave, Tidy Trousers, Feather Trim, Schnauzer Cut, De-shed &
Fluff). You meet every breed once, golden retriever first, before the regulars come back round.
Progress, upgrades and the last twelve polaroids are saved in the browser.

## Code map

```
src/
  core/      springs, rigid bodies, spatial hash, input
  dog/       breeds & cuts, Dog (skeleton physics + behaviour), Fur (strand sim, grooming ops, rendering), Bow
  fx/        water & shampoo gel, bubbles, clipped tufts, sparkles/hearts, coins
  world/     the salon (room, tub, table, window and rain), towel cloth, hose ropes, canvas textures
  tools/     tool viewmodels and what each tool does to the coat
  game/      appointment state machine, owners, photos, upgrades, save, debug hooks
  ui/        HUD, modals, icons
  audio/     all sound is synthesised with WebAudio (no sample files)
```

`npm run smoke` plays one whole appointment headlessly against the production build and fails on any
page error (needs Playwright: `npm i -D playwright && npx playwright install chromium`).

`window.__suds` exposes a few debug helpers (`lab('poodle', 'table')`, `wash()`, `dry()`, `clip()`,
`stats()`), which is how the smoke tests drive the simulation.
