/**
 * The prompt gallery — 32 curated examples, each with the prompt that made it.
 *
 * Transcribed from franklin.run/gallery, which is a SHOWCASE rather than a history: real prompts
 * with their results, there to be read, copied and re-run. That is a different thing from the
 * gallery this app already had, which lists the media the user themselves paid for — hence two
 * tabs rather than one merged list. Merging them would put someone else's example next to your
 * own $0.40 video with no way to tell which is which.
 *
 * ATTRIBUTION IS PART OF THE DATA, not decoration. These prompts were written by named people
 * (18 distinct handles) and the video prompts come from YouMind-OpenLab/awesome-seedance-2-prompts.
 * Franklin credits every one, and so does this. `author` and `credit` are therefore required
 * reading wherever a prompt is shown.
 *
 * The `{argument name="…" default="…"}` placeholders inside the prompts are left exactly as
 * written. They mark the parts meant to be changed — a headline, a brand name — and rewriting
 * them into finished text would remove the one thing that makes a prompt reusable.
 *
 * Media lives on our own R2 under `showcase/`, not hotlinked. Two independent reasons, both
 * measured: the page's CSP allows images only from `self`, `data:` and our CDN, and the CDN
 * Worker's copy-from allowlist refuses franklin.run outright (403, host not allowed). Uploaded
 * by cdn/upload-showcase.sh; that prefix has no expiry rule, unlike `media/` which is a cache
 * and clears daily.
 */

import { CDN_BASE_URL } from './gallery'

export interface ShowcaseItem {
  slug: string
  title: string
  /** The model that produced it, as published. */
  model: string
  /** The prompt's author, when they are credited by handle. */
  author: string | null
  kind: 'image' | 'video'
  /** Filename under showcase/ on the CDN. */
  asset: string
  /** Still frame for a video, when it differs from the asset itself. */
  poster: string | null
  /**
   * The full prompt. Null for the four launch-film stills, which were assembled with a skill
   * rather than a single prompt — there is nothing to copy, and inventing one would be worse
   * than the button being absent.
   */
  prompt: string | null
  /** Upstream source for the prompt, where one is published. */
  credit: string | null
}

/** Absolute URL for a showcase asset. */
export function showcaseUrl(file: string): string {
  return `${CDN_BASE_URL}/showcase/${file}`
}

/**
 * Which generation mode a showcase item's prompt should run in.
 *
 * Mapped from the published model name rather than guessed from the media type: a still frame
 * from a video shoot is an image file describing a video prompt, and sending it to the image
 * endpoint would produce a poster of a scene instead of the scene.
 */
export function showcaseMode(item: ShowcaseItem): 'image' | 'video' {
  return /seedance/i.test(item.model) ? 'video' : 'image'
}

export const SHOWCASE: ShowcaseItem[] = [
  {
    slug: "vid-orange-cat-ninja",
    title: "Orange Cat Ninja Heist",
    model: "SeeDance 2.0",
    author: null,
    kind: "video",
    asset: "video-orange-cat-ninja.mp4",
    poster: "video-orange-cat-ninja-poster.jpg",
    prompt: "STORY FORMAT: 15s / 150 BPM / MULTI-CUT with one continuous acrobatic segment / American dark comedy with absurd ninja satire / playful mischief with a twisted punchline\nTONE: sneaky curiosity → rising temptation → covert action → sudden exposure → ridiculous charm reversal\nSETTING: Nighttime traditional Japanese house, wooden structure, tiled roof, soft moonlight, Mount Fuji silhouette in the background, pine trees swaying, cool blue tones with warm kitchen light contrast\nCHARACTERS:\nOrange cat ninja: dressed in full black ninja outfit, only eyes and mouth visible, agile, sneaky, slightly goofy greed-driven personality\nWhite cat cook: wearing a pink kimono, gentle but easily startled, expressive reactions\nBlack bear father: wearing a red belly cloth, sitting at a wooden table in the courtyard, stern and impatient, loud presence\nCAMERA STYLE: cinematic push-ins, stealth POV shots, smooth tracking, sudden comedic snap zooms, light handheld shake during action, exaggerated smoke effects\nSCENE\n0–2s\nWide shot: Rooftop silhouette\nThe orange cat ninja crouches on the edge of a tiled roof, moonlight outlining his figure\nMount Fuji and pine trees in the background\nHe slowly leans forward, peeking into a lit kitchen window\n2–4s\nPOV shot into kitchen\nThe white cat stands by the stove, stir-frying with a spatula\nThick white smoke rises heavily\nThe smoke drifts upward… reaching the ninja\nClose-up: ninja sniffing\nHe pauses… then grins\nA little drool forms\nOrange cat (whispering):\n“Oh yeah… that smells illegal.”\n4–6s\nCut to courtyard\nThe black bear sits at a wooden table, tapping impatiently\nBlack bear (yelling):\n“Kid! Is dinner ready or what?!”\n6–7s\nCut back to kitchen\nWhite cat panics\nShe hurriedly scoops food from the pan onto a cracked plate\nWhite cat (nervous):\n“It’s ready! Coming!”\nSome food still remains in the pan\n7–9s\nShe carefully carries the plate outside\nPlaces it in front of the black bear\nHe nods with smug satisfaction\nBlack bear:\n“About time.”\n9–10s\nCut to rooftop\nOrange cat narrows eyes\nOrange cat (whispering):\n“Perfect timing.”\n10–13s CONTINUOUS ACTION SHOT\nThe ninja launches\n— flips off the roof in one smooth motion\n— lands silently near the kitchen entrance\n— quickly looks left and right\nNo one\nHe slips inside\nRuns to the stove\nStarts grabbing food with his bare hands\nOrange cat (excited whisper):\n“Five-finger buffet, let’s go.”\nHe lifts food toward his mouth\n13–14s\nSuddenly\nWhite cat appears in the doorway\nWhite cat (shocked):\n“Who are you?!”\nFreeze beat\n14–15s FINAL PAYOFF\nThe ninja instantly throws a smoke bomb to the ground\nOrange cat (shouting):\n“SMOKE EXIT, BABY!”\nBlack smoke bursts everywhere\nWhen it clears\nThe ninja is gone\nIn his place—\nA small, cute white fox\nThe white cat gasps, hands clasped\nWhite cat (soft, melted):\n“Oh my gosh… you’re adorable…”\nFinal shot\nThe white fox looks directly at camera\nWinks one eye\nA sly, mischievous grin forms",
    credit: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/blob/main/README.md",
  },
  {
    slug: "vid-cgi-action",
    title: "3D CGI Action Sequence",
    model: "SeeDance 2.0",
    author: null,
    kind: "video",
    asset: "video-cgi-action.mp4",
    poster: "video-cgi-action-poster.jpg",
    prompt: "Fast-paced editing cuts. 3D CGI animation with a real-time game engine feel, dynamic lighting, and post-processing bloom. Smooth 60fps visuals. The protagonist is a beautiful female warrior. The animation unfolds to the rhythm of music as follows: A lithe warrior in flowing attire sprints forward at a blurred speed, unsheathing a blade mid-run with a crisp metallic ring. The camera zooms in to focus on the cold glint of the blade as she strikes an oncoming mechanical enemy. The warrior precisely side-steps to dodge a heavy projectile that grazes past her; time briefly slows down before she accelerates, spinning like a whirlwind to release a series of rapid slashes that leave glowing trails in the dim ruins. Elegantly leaping into the air, the warrior fires a barrage of energy projectiles from dual weapons, the barrage raining down like comets on a gathered group of enemies below, each impact explosion shaking the screen violently. A close-up shows the warrior's determined eyes locking onto a charging opponent, followed by a fluid roll-dodge that seamlessly transitions into a counter-thrust, the blade piercing through armor and erupting in sparks and debris. The camera shifts to a wide angle, showing the warrior weaving through a dense barrage of laser fire, her body twisting in acrobatic flips, each move blurring into the next as she closes in for a devastating overhead strike. In a burst of explosive acceleration, the warrior summons illusory projectiles circling her before charging forward like a comet; the resulting shockwave spreads outward, shattering barriers and enemies alike. Rapid-fire sequence: The warrior parries a claw attack with crossed blades, sparks flying, and immediately counters with ultra-high-speed thrusts, precisely piercing vital points as the enemy's frame collapses in slow-motion chaos. The warrior grapples a larger mechanical beast, quickly climbing while dodging its swings, reaching the top to deliver a diving attack that sends cracks spreading like webs across its surface, finally triggering a massive explosion. Amidst collapsing buildings, the warrior performs wall-run dodges transitioning into an aerial backflip, concluding with a ground shockwave that repels surrounding enemies in a ring of dust and energy. Final Burst: The warrior channels her inner power, her whole body glowing, releasing a flood of slashes and shots in every direction. The camera rotates around her, capturing the dizzying speed and overwhelming offensive power. The 15-second sequence is well-paced, with a cut rhythm designed to make scene transitions and emotional flow easy to follow.",
    credit: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/blob/main/README.md",
  },
  {
    slug: "vid-jungle-drone",
    title: "Amazon Jungle Drone Flight",
    model: "SeeDance 2.0",
    author: null,
    kind: "video",
    asset: "video-jungle-drone.mp4",
    poster: "video-jungle-drone-poster.jpg",
    prompt: "A hyper-realistic, cinematic 14-second vertical video (9:16 aspect ratio) shot at 60fps with intense motion blur and dynamic tracking camera work. The main subject is a sleek, futuristic insectoid drone with an iridescent metallic blue-green exoskeleton that shifts in the light like a beetle shell. It has two large glowing orange compound eyes that pulse with energy, spinning translucent propeller-wings that blur into discs during high-speed flight, thin black mechanical legs/tendrils, and long antennae. The drone is highly agile, fast, and organic in its movements, like a living cybernetic dragonfly.\nScene sequence (timed for precise 14-second duration):\n0–2s: Extreme high-angle aerial shot racing over a vast, endless emerald-green Amazonian jungle canopy under bright daylight. The drone bursts into frame from the top, flying directly toward camera at breakneck speed before diving sharply downward into the dense forest.\n2–8s: Chaotic, high-speed first-person and close third-person chase through the thick jungle interior. The drone weaves aggressively between massive moss-covered tree trunks, hanging vines, and dense ferns at dizzying speed. Volumetric god rays pierce the misty air. Brightly colored macaws (vivid red, blue, and yellow) scatter and fly chaotically around it, some nearly colliding with the drone. Camera follows tightly with whip pans, Dutch angles, and rapid tilts to convey extreme velocity and danger. Heavy motion blur on background foliage. The drone tilts, rolls, and banks sharply to avoid branches, its orange eyes glowing brighter during maneuvers.\n8–11s: Tight, dramatic close-ups of the drone as it navigates deeper into darker, mistier sections of the jungle. Sunlight shafts cut through the canopy. The drone’s propellers spin furiously, occasionally clipping leaves and sending small debris flying. Its iridescent body reflects greens and golds from the environment. Camera orbits and pushes in close for mechanical detail.\n11–14s: The drone bursts out of the dense jungle into a breathtaking open clearing. It flies straight toward a massive, powerful waterfall cascading dramatically into a turquoise lagoon far below. Thick white mist fills the air, creating a perfect rainbow arching across the scene. The drone hovers briefly in the center of frame, backlit by the waterfall and rainbow, its glowing orange eyes and iridescent shell catching the light dramatically. Final shot slowly pulls back to reveal the full majestic scale of the waterfall and rainbow as the drone holds position.",
    credit: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/blob/main/README.md",
  },
  {
    slug: "vid-kitchen-comedy",
    title: "Super-Speed Kitchen Comedy",
    model: "SeeDance 2.0",
    author: null,
    kind: "video",
    asset: "video-kitchen-comedy.mp4",
    poster: "video-kitchen-comedy-poster.jpg",
    prompt: "Cinematic super-speed cooking commercial, Flash-style kitchen action comedy aesthetic, high-energy dynamic mood with playful twist. Shot on ARRI Alexa Mini LF with 24mm wide and 50mm lens, shallow depth of field, cinematic film grain, high contrast color grading. Color palette: warm kitchen amber and brass, electric yellow and blue speed trails, vibrant vegetable greens and reds, golden fire flames, creamy whites. Lighting: warm overhead pendant kitchen lights, flashes of fire and electric speed energy, atmospheric steam and flour dust catching the light. Hyper-dynamic camera with rapid whip-pans, speed ramps, orbital moves, bullet time freezes.\nHero: Western young woman with straight blonde hair, fair skin, expressive face, natural makeup, confident yet playful energy. Casual modern outfit (light neutral tones), slightly tousled straight blonde hair catching the light.\nMOOD: Energetic, fun, heroic, delicious. The feeling of a Flash superhero using her powers for the most important mission — dinner.\nTIMELINE:\n0:00–0:02 — Opening shot\nHero stands in the middle of a beautiful modern kitchen in profile, hands in pockets, looking at a completely empty wooden dining table in front of her. Her stomach audibly rumbles. She looks tired and hungry. Camera slowly pushes in from the side. Warm amber kitchen light, quiet peaceful atmosphere.\n0:02–0:03 — The decision\nShe slowly closes her eyes with a subtle confident smirk spreading across her face. Electric yellow energy begins to crackle softly around her body. A few strands of her straight blonde hair lift slightly from the energy. Camera freezes on her smirk for a beat. Bass drop moment.\n0:03–0:05 — The explosion of speed\nShe bursts into super-speed motion in slow motion 120fps, leaving electric yellow and blue speed trails behind her. Camera rapidly tracks as she zips to the refrigerator, flings it open, multiple vegetables and ingredients fly out into the air in slow motion — tomatoes, herbs, onions, peppers, all suspended mid-flight.\n0:05–0:07 — Super-speed chaos montage\nRapid quick-cut sequence of hyper-dynamic kitchen action, each cut 0.3 seconds: she zips past the counter with speed trails, a knife spins in the air chopping vegetables by itself, a pan on the stove bursts into flames, a pot of boiling water steams dramatically, flour clouds explode in the air, a mixer runs without being touched, spices sprinkle themselves over ingredients. Electric speed trails crisscross the kitchen in all directions. Camera rapidly whip-pans between every action.\n0:07–0:09 — The plating\nExtreme macro close-ups in rapid succession — sauce pouring in a perfect swirl, vegetables placing themselves on a plate in elegant arrangement, garnish floating down gently, a perfect steak searing in a pan with orange flames, pasta twirling through the air, parmesan grating itself in slow motion. Every shot is hyper-detailed, restaurant-quality food styling. Warm",
    credit: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/blob/main/README.md",
  },
  {
    slug: "zodiac-water",
    title: "Water Signs Zodiac Character Poster",
    model: "GPT Image 2",
    author: "@komorimedia",
    kind: "image",
    asset: "poster-zodiac-water.jpg",
    poster: null,
    prompt: "{\"type\":\"Chinese zodiac-style character infographic poster\",\"subject\":\"twelve zodiac character list, water signs edition\",\"language\":\"Traditional Chinese\",\"format\":\"vertical poster\",\"style\":{\"overall\":\"elegant anime-inspired character catalog with editorial infographic layout\",\"rendering\":\"soft polished digital illustration, pastel gradients, delicate sparkles, ornamental border design\",\"mood\":\"dreamy, celestial, refined, feminine, aquatic\"},\"canvas\":{\"aspect_ratio\":\"2:3\",\"background\":\"very light pearl white with pale blue-lavender tint, subtle texture, thin decorative frame with filigree corners and tiny stars\"},\"header\":{\"title\":\"{argument name=\\\"headline text\\\" default=\\\"十二星座角色清單|水象星座\\\"}\",\"subtitle\":\"感受・直覺・共鳴\",\"icons\":[\"small stars\",\"water droplet emblem in top right\",\"curled cloud-like line art in top left\"]},\"layout\":{\"sections_count\":3,\"sections\":[{\"title\":\"巨蟹座 Cancer\",\"position\":\"top panel\",\"theme_color\":\"powder blue\",\"zodiac_symbol\":\"Cancer glyph inside circle at left\",\"constellation\":\"Cancer constellation at upper right\",\"count\":6,\"labels\":[\"元素:水\",\"概念:情感守護者,把人放在心上\",\"性格:溫柔、敏感、顧家\",\"行動原則:先確認感受,再保護重要的人\",\"戀愛傾向:慢慢靠近,越熟越黏\",\"人際怪癖:嘴上說沒事,實際會記很久\"],\"character\":{\"identity\":\"same young woman model reimagined as zodiac character\",\"pose\":\"half-body portrait, facing forward, arms gently wrapped around a large seashell pillow\",\"hair\":\"long dark hair in a low ponytail\",\"outfit\":\"light blue celestial slip dress with lace trim and sheer cardigan embroidered with stars and moons\",\"accessories\":\"minimal jewelry\",\"background\":\"soft blue night sky with crescent moon, seashell, sparkling stars, stylized ocean wave and tiny water droplets\"}},{\"title\":\"天蠍座 Scorpio\",\"position\":\"middle panel\",\"theme_color\":\"deep violet\",\"zodiac_symbol\":\"Scorpio glyph inside circle at left\",\"constellation\":\"Scorpio constellation at upper right\",\"count\":6,\"labels\":[\"元素:水\",\"概念:深海偵察者,情緒有深度\",\"性格:專注、神秘、意志強\",\"行動原則:先觀察,再一擊到位\",\"戀愛傾向:愛得深,重忠誠與獨占感\",\"人際怪癖:越在乎越不說,會偷偷試探\"],\"character\":{\"identity\":\"same young woman model reimagined as zodiac character\",\"pose\":\"half-body portrait, one hand near chin in a composed, enigmatic gesture\",\"hair\":\"long dark ponytail\",\"outfit\":\"black semi-sheer dress with gothic details and a dark plum off-shoulder shawl\",\"accessories\":\"dangling earrings and layered necklace\",\"background\":\"dark purple celestial sea scene with crescent moon, bubbles, stars, and curling misty water shapes\"}},{\"title\":\"雙魚座 Pisces\",\"position\":\"bottom panel\",\"theme_color\":\"lavender\",\"zodiac_symbol\":\"Pisces glyph inside circle at left\",\"constellation\":\"Pisces constellation at upper right\",\"count\":6,\"labels\":[\"元素:水\",\"概念:夢境共感者,靠直覺導航\",\"性格:浪漫、柔軟、有想像力\",\"行動原則:先感受,再順流找答案\",\"戀愛傾向:容易心動,渴望靈魂陪伴\",\"人際怪癖:常把別人的情緒也一起感受\"],\"character\":{\"identity\":\"same young woman model reimagined as zodiac character\",\"pose\":\"half-body portrait, one hand lifted as if balancing floating bubbles, other hand resting lightly at chest\",\"hair\":\"long dark ponytail with a pale flower hair ornament\",\"outfit\":\"translucent lavender fantasy dress with soft draped sleeves and shimmering fabric\",\"accessories\":\"delicate earrings and necklace\",\"background\":\"pale lilac underwater-celestial blend with bubbles, sparkles, and flowing translucent wave forms\"}}],\"dividers\":\"three horizontal framed panels with thin ornamental borders\"},\"footer\":{\"center_icon\":\"small blue seashell emblem\",\"decorations\":[\"tiny stars\",\"fine scrollwork\"]},\"constraints\":[\"all three zodiac entries must use the same woman as the base character with different styling, clothing, pose, and mood\",\"text should be clean, editorial, and readable\",\"each panel should clearly separate illustration area on the left and text block on the right\",\"maintain cohesive water-element theme across all 3 signs\",\"do not include the other nine zodiac signs in this image\"]}",
    credit: null,
  },
  {
    slug: "nike-lumina",
    title: "Neon Nike Lumina Ad Poster",
    model: "GPT Image 2",
    author: "@alwavenazca",
    kind: "image",
    asset: "poster-nike-lumina.jpg",
    poster: null,
    prompt: "A high-energy vertical Nike fashion campaign poster featuring a single athletic young woman mid-jump against a futuristic neon studio background. She is captured in a dynamic airborne pose with one knee bent up, the other leg folded back, one arm extended outward and the other bent near her chest, conveying motion and power. Her face is obscured by a clean rectangular blur block centered over the face. She wears a cropped iridescent white hooded windbreaker with a black zipper and small Nike logo on the chest, holographic metallic lavender-blue leggings with a subtle Nike swoosh on the thigh, a black branded waistband visible above the leggings, and white chunky Nike sneakers. Her brown hair is tied in a high ponytail flying outward with the jump. Behind her, enormous glowing white serif letters spell “NIKE” across the upper half, with a small white Nike swoosh centered above the word. Across the middle background, the phrase “LUMINA” appears once in wide bold glowing letters with a horizontal glitch and scanline distortion effect, partially obscured by the model. The color palette is saturated magenta, violet, cyan, and electric blue with strong bloom, glossy highlights, lens flares, and chromatic aberration. Add sweeping circular light trails wrapping around the model’s legs and body, suggesting speed and motion. The overall style is premium sportswear advertising, ultra-polished, cinematic, high contrast, hyperreal retouching, crisp product detail, dramatic rim lighting, and a luminous holographic aesthetic. Place 2 small text lines at the bottom: bottom left reads {argument name=\"tagline text\" default=\"LIGHT. MOTION. ENERGY.\"}, bottom right reads {argument name=\"collection name\" default=\"NIKE LUMINA COLLECTION\"} followed by a small Nike swoosh. Include exactly 3 visible Nike swooshes total: 1 above the large NIKE headline, 1 on the jacket chest, and 1 on the leggings.",
    credit: null,
  },
  {
    slug: "idol-mist",
    title: "Soft Black Mist Idol Portrait",
    model: "GPT Image 2",
    author: "@bubblebrain",
    kind: "image",
    asset: "portrait-idol-mist.jpg",
    poster: null,
    prompt: "9:16 vertical — Korean idol portrait photography, single subject  soft black mist filter effect, lowered contrast, gentle highlight bloom, subtle glow, soft diffusion, slightly faded blacks  minimal indoor setting near window, white curtains, clean light-toned background  young Korean female idol, natural minimal makeup, dewy realistic skin texture, subtle imperfections  outfit: oversized white button-up shirt + short bottoms, slightly loose fit, soft and casual styling, no revealing elements  hair: long dark hair, slightly messy, natural volume, softly flowing  pose: relaxed standing or slight lean, body subtly angled, one leg slightly forward, shoulders relaxed; one hand lightly touching collar or resting near neckline, the other relaxed; gentle body curve without exaggeration  expression: soft cute smile, slightly playful eyes, direct or slightly off-camera gaze  camera: close to mid-body framing, eye-level, intimate distance, slight handheld feel  lighting: diffused natural daylight, soft shadows, gentle light wrapping around face and body  mood: cute yet subtly sensual, intimate, everyday softness, quiet romantic atmosphere  quality: ultra-realistic, fine film grain, slight softness at edges, natural imperfections, dreamy understated tone",
    credit: null,
  },
  {
    slug: "anime-travel",
    title: "Anime Fantasy Travel Movie Poster",
    model: "GPT Image 2",
    author: "@design4p0",
    kind: "image",
    asset: "poster-anime-travel.jpg",
    poster: null,
    prompt: "A cinematic anime movie poster for a fictional film titled {argument name=\"headline text\" default=\"EL VIAJE DE LA LUNA DE PLATA\"}, in polished modern Japanese animation style with a natural, less over-detailed look. Center a teenage anime girl from mid-thigh up, facing forward, with a short silver bob haircut, pale skin, a black choker, small black geometric earrings, a white tank top, and a dark navy oversized zip hoodie with two yellow stripes running down the sleeves. She has a backpack strap over one shoulder and both hands tucked casually into the hoodie pockets. Her face is obscured by a flat rectangular censor block in a muted beige tone, covering the entire face area. Place her in a dramatic twilight coastal city setting that blends travel, nostalgia, and fantasy: on the left, a lit train platform with a commuter train approaching, its destination sign showing Japanese characters; behind it, a glowing city skyline with a ferris wheel. In the distance and lower left, layered mountains and a winding illuminated valley road. On the right, a cliffside coast at sunset with the sea reflecting warm light, a crescent moon in the sky, several flying seabirds, and a curving highway descending along the hillside. Also on the right, include a wooden signpost with exactly 3 directional signs labeled \"NUEVOS CAMINOS\", \"VIEJOS RECUERDOS\", and \"SIN LÍMITES\". At the top center, add the Spanish tagline {argument name=\"tagline text\" default=\"CADA DESTINO CAMBIA SU HISTORIA\"} in elegant serif capitals. On the upper left, create an awards column in gold typography with laurel wreaths and exactly 4 award blocks: one text block reading \"GANADORA DE MÚLTIPLES PREMIOS\" with 5 gold stars beneath it, then three laurel award sections reading \"MEJOR PELÍCULA ANIMADA / FESTIVAL INTERNACIONAL DE ANIMACIÓN / 2024\", \"PREMIO DEL PÚBLICO / FESTIVAL INTERNACIONAL DE CINE / 2024\", and \"MEJOR BANDA SONORA ORIGINAL / ACADEMIA DE CINE ANIMADO / 2024\". Place the film title large across the lower center in luminous ornate serif lettering with a magical glow and sweeping flourishes, layered partly over the character. Beneath it, add the Spanish quote {argument name=\"quote\" default=\"A veces, para encontrarte... tienes que perderte en el mundo.\"}. Below that, add \"UNA PELÍCULA DE ESTUDIO LUMINARIA\" in small caps. At the bottom, add the release line {argument name=\"release text\" default=\"PRÓXIMAMENTE EN CINES\"} in large gold serif capitals, plus tiny production logos and credits along the footer, including a small studio emblem on the left. Rich blue, violet, and warm sunset orange palette, glossy poster lighting, romantic adventure mood, balanced composition, highly polished theatrical key art, vertical one-sheet film poster.",
    credit: null,
  },
  {
    slug: "prs-guitar",
    title: "Vintage PRS Guitar Lineage Poster",
    model: "GPT Image 2",
    author: "@glennhasabeard",
    kind: "image",
    asset: "poster-prs-guitar.jpg",
    poster: null,
    prompt: "{\"type\":\"luxury vintage guitar comparison infographic poster\",\"subject\":\"a highly detailed, vertically oriented PRS electric guitar lineup chart designed like a premium museum poster or collector's reference board\",\"style\":\"ornate, dark, glossy, high-contrast, gold-foil typography, elegant wood-and-metal textures, symmetrical grid layout, premium catalog aesthetic, subtle vintage patina, ultra sharp graphic design\",\"branding\":{\"main headline\":\"THE LEGENDARY LINEAGE OF {argument name=\\\"brand name\\\" default=\\\"PRS GUITARS\\\"}\",\"subheadline\":\"EVERY ICON. EVERY LINE. ONE HERITAGE.\",\"signature\":\"Paul Reed Smith\",\"left seal\":\"PAUL REED SMITH GUITARS\",\"right seal\":\"MADE IN MARYLAND U.S.A.\"},\"palette\":{\"background\":\"black and deep charcoal with dark figured wood accents\",\"primary\":\"antique gold\",\"secondary\":\"cream\",\"accent colors\":[\"deep green\",\"teal\",\"royal blue\",\"purple\",\"gold\",\"burgundy\"]},\"layout\":{\"format\":\"single-page vertical poster\",\"header\":{\"position\":\"top\",\"elements\":[\"large central title\",\"small tagline below\",\"script signature\",\"2 circular emblems in upper left and upper right\",\"3 horizontal legend boxes under the title\"]},\"sections\":[{\"title\":\"PRESTIGE TIER KEY\",\"position\":\"upper left below title\",\"count\":6,\"labels\":[\"SE\",\"S2\",\"CE\",\"CORE\",\"WOOD LIBRARY\",\"PRIVATE STOCK\"]},{\"title\":\"PICKUP ICON KEY\",\"position\":\"upper center-right below title\",\"count\":7,\"labels\":[\"HH\",\"HSH\",\"P-90\",\"SOAP\",\"58/15\",\"TCI\",\"Bass\"]},{\"title\":\"TONAL CHARACTER KEY\",\"position\":\"upper right below title\",\"count\":7,\"labels\":[\"Warm / Vintage\",\"Balanced / All-around\",\"Bright / Articulate\",\"High Gain / Modern\",\"Blues / Classic Rock\",\"Metal / Progressive\",\"Funk / Soul / Clean\"]},{\"title\":\"CORE\",\"position\":\"first main row left label\",\"count\":7,\"labels\":[\"Custom 24\",\"McCarty 594\",\"DGT (David Grissom)\",\"Custom 22\",\"Hollowbody II\",\"SC 594\",\"row category panel\"]},{\"title\":\"S2\",\"position\":\"second main row left label\",\"count\":6,\"labels\":[\"S2 Custom 24\",\"S2 McCarty 594\",\"S2 Standard 24\",\"S2 Vela\",\"S2 Singlecut\",\"S2 Mira\"]},{\"title\":\"SE\",\"position\":\"third main row left label\",\"count\":6,\"labels\":[\"SE Custom 24\",\"SE Standard 24\",\"SE Paul's Guitar\",\"SE Santana\",\"SE Hollowbody II\",\"SE Mark Holcomb\"]},{\"title\":\"CE\",\"position\":\"fourth main row left label\",\"count\":6,\"labels\":[\"CE 24\",\"CE 22\",\"CE 24 Semi-Hollow\",\"CE 24 Floyd\",\"CE 24 Satin\",\"CE Bass\"]},{\"title\":\"BOLT-ON SERIES\",\"position\":\"fifth main row left label\",\"count\":6,\"labels\":[\"NF 53\",\"Silver Sky\",\"NF 3\",\"NF 53 Satin\",\"DGT Bolt-On\",\"Studio\"]},{\"title\":\"PRIVATE STOCK\",\"position\":\"sixth main row left label\",\"count\":6,\"labels\":[\"Dragon I\",\"Frostbite\",\"#4004\",\"The Tree of Life\",\"#8731\",\"PS DGT\"]}],\"footer\":{\"position\":\"bottom\",\"elements\":[\"small badge at lower left\",\"centered company line\",\"right-side script signature\"]}},\"content grid\":{\"total guitar models shown\":37,\"card design\":\"each product card contains a guitar render, model name, year, small pickup icons, a short descriptive blurb, and origin/wood specs at the bottom\",\"row side panels\":6},\"visual details\":{\"guitars\":\"front-facing electric guitars with varied body shapes and highly polished figured maple tops, metallic and transparent finishes, some solid colors, some natural wood\",\"typography\":\"all caps serif headlines, small serif body text, script signature accents\",\"borders\":\"thin decorative gold rules around every panel and the full poster\",\"lighting\":\"studio-lit instruments against dark panel backgrounds\",\"render quality\":\"clean infographic precision with realistic product renders\"},\"camera\":\"straight-on flat poster view, no perspective distortion, centered composition\",\"quality\":\"ultra detailed, print-ready, high-resolution editorial infographic, luxury brand poster\"}",
    credit: null,
  },
  {
    slug: "hermes-avatar",
    title: "Monochrome Hermès-Inspired Avatar",
    model: "GPT Image 2",
    author: "@jiajia232016",
    kind: "image",
    asset: "avatar-hermes-mono.jpg",
    poster: null,
    prompt: "Create a minimalist black-and-white vector avatar logo of a mythic anime woman shown in elegant side profile facing right, cropped from the chest up on a plain white background. Give her long flowing {argument name=\"hair color\" default=\"black\"} hair with bold white highlight streaks and smooth graphic shapes, rendered as high-contrast ink silhouette art with clean sharp edges. She wears a winged headpiece reminiscent of Hermes or a messenger god helmet, with one large white feathered wing visible on the side of her head and a circular metallic earpiece detail. Dress her in a sleek high-collar garment with a luxury-fashion feel, and hang a prominent pendant or zipper pull shaped like the letter {argument name=\"monogram letter\" default=\"H\"} at the center of the collar. The face is intentionally obscured by a centered soft gray rectangular blur block covering most facial features, creating a censored anonymous profile-image effect. Overall style: luxury brand avatar, fashion logo, anime-inspired goddess silhouette, monochrome vector emblem, smooth negative-space highlights, balanced composition, modern and iconic, suitable for a social media profile picture.",
    credit: null,
  },
  {
    slug: "good-bath",
    title: "Good Bath Day Editorial Poster",
    model: "GPT Image 2",
    author: "@kazuch75240438",
    kind: "image",
    asset: "poster-good-bath.jpg",
    poster: null,
    prompt: "Create a soft editorial lifestyle poster for {argument name=\"event date\" default=\"4.26\"} celebrating Japanese bath culture, designed like a refined magazine feature page in portrait orientation. The layout is split into two main columns with a pale cream and warm gray background, thin divider lines, elegant serif typography, and muted sage-green accents. At the top left, include the small heading “LIFESTYLE / FEATURE”, then a large date line reading “{argument name=\"event date\" default=\"4.26\"} EVENT”, followed by the large Japanese title “よい風呂の日” and the subtitle “特集” in sage green, with a small bathtub icon nearby. Beneath that, add the Japanese tagline “心も体も、ととのう時間。” and several short body-text blocks in Japanese explaining the meaning of Good Bath Day, including references to “4(よ)2(ふ)6(ろ)” and the benefits of bathing for body and mind. On the right side, show a bright, airy bathroom interior lit by soft natural morning light from a window, with beige and off-white tones, a wooden counter, folded white towels, a pump bottle, a sponge, woven baskets, and a few green plants. In front of the bathroom scene, place a youthful anime-style person with {argument name=\"hair color\" default=\"soft medium brown\"} tousled short hair, fair skin, and a relaxed expression, standing in a casual post-bath pose. The character wears a loose white T-shirt with a tiny dark square chest logo and light brown drawstring lounge pants, one hand in a pocket and the other holding a white towel up near the face and shoulder, conveying a fresh, just-bathed feeling. Near the character, include the handwritten-style Japanese side note “湯上がりの、リラックスタイム。” Add an oval badge on the lower right of the main image area with the English heading “GOOD BATH DAY” and Japanese explanatory text inside, plus a small bathtub icon. Below the main feature, include exactly 2 small inset images of the same character in the bathroom, each framed as rectangular mini-panels with narrow vertical Japanese captions beside them. At the bottom, create exactly 4 rounded rectangular information cards in a row: card 1 labeled “POINT 01” with the heading “お風呂の基本” and text about soaking in lukewarm water around 38–40°C; card 2 labeled “POINT 02” with the heading “日常でできること” and text about making bathing part of a routine instead of only showering; card 3 labeled “POINT 03” with the heading “楽しみ方・取り入れ方” and text about bath salts, scents, music, and lighting; card 4 labeled “まとめ” with concluding Japanese text about sustainable self-care. Decorate the cards with small illustrated elements such as leaves, a bathtub, a candle, a bottle, lavender sprigs, and a basket of folded towels. Along the very bottom, add a horizontal green tip strip labeled “今日からできる TIP” with exactly 3 checklist items: “就寝の1〜2時間前に入浴する”, “スマホは浴室に持ち込まない”, and “水分補給を忘れずに”. Place a final handwritten-style Japanese phrase at the lower right reading “自分をいたわる時間を。” The overall look should be clean, gentle, wellness-focused, feminine-neutral, and polished like a Japanese seasonal magazine infographic, with delicate anime illustration, soft shadows, subtle textures, and calm spa-like atmosphere.",
    credit: null,
  },
  {
    slug: "pastel-anime",
    title: "Soft Pastel Anime Girl",
    model: "GPT Image 2",
    author: "@hoshi122221",
    kind: "image",
    asset: "char-pastel-anime.jpg",
    poster: null,
    prompt: "A full-body anime girl character design on a plain white background, centered and floating slightly, drawn in a soft minimalist pastel style with very thin gray linework and delicate flat colors. She has a petite youthful build and a cute, gentle silhouette, with special emphasis on a soft rounded face shape, smooth cheeks, and a softened jawline and chin. Her face is completely obscured by a blank skin-colored rectangular block with no facial features visible. She has short bob hair in {argument name=\"hair color\" default=\"light ash brown\"}, slightly tousled with wispy ends, long bangs covering part of the forehead, and a small ribbon hair tie on the right side in pale blue-gray. She wears 3 visible clothing pieces: an oversized pale blue cardigan with loose sleeves and front buttons, a cream-white slip dress with a scalloped neckline and a tiny button detail at the chest, and a frilled hem with a small ribbon near the right thigh. She is barefoot with slim pale legs, posed front-facing with both arms relaxed slightly outward, open hands, one leg straight and the other gently bent inward for a shy, weightless look. The illustration should feel airy, cute, understated, and clean, like a simple Japanese anime fashion sketch, with lots of negative space and no props, no shadows, and no background elements.",
    credit: null,
  },
  {
    slug: "vr-exploded",
    title: "VR Headset Exploded View Poster",
    model: "GPT Image 2",
    author: "@wory37303852",
    kind: "image",
    asset: "poster-vr-exploded.jpg",
    poster: null,
    prompt: "{\n  \"type\": \"exploded view product diagram poster\",\n  \"subject\": \"VR headset\",\n  \"style\": \"clean high-tech 3D render, studio lighting, glowing accents\",\n  \"background\": \"{argument name=\\\"background color\\\" default=\\\"soft purple and blue gradient\\\"}\",\n  \"header\": {\n    \"logo\": \"∞ {argument name=\\\"product name\\\" default=\\\"Meta Quest 3\\\"}\",\n    \"subtitle\": \"{argument name=\\\"main catchphrase\\\" default=\\\"まったく新しい現実を、まったく新しい構造から。\\\"}\"\n  },\n  \"layout\": {\n    \"centerpiece\": \"vertically stacked exploded view of a VR headset showing 9 distinct layers of internal components: outer shell, camera sensors, motherboard with chip, pancake lenses, internal frame, battery packs, side straps, top strap, and facial interface cushion.\",\n    \"callout_labels\": {\n      \"count\": 8,\n      \"left_side\": [\n        \"Snapdragon® XR2 Gen 2\\n圧倒的な処理性能でリアルタイムな体験を。\",\n        \"調整可能なIPD機構\\n幅広いユーザーに快適なフィット感を。\",\n        \"精密設計されたヘッドストラップ\\n快適さと安定性を追求したエルゴノミクス。\"\n      ],\n      \"right_side\": [\n        \"フェイスプレート\\n洗練されたデザインと最適な重量バランス。\",\n        \"トラッキングカメラ\\n高精度な位置トラッキングと環境認識を実現。\",\n        \"パンケーキレンズ\\n薄型設計で広い視野角と鮮明な映像を提供。\",\n        \"高性能バッテリー\\n長時間駆動を支える最適化された電源設計。\",\n        \"柔らかなフェイスインターフェース\\n長時間でも快適な装着感を実現。\"\n      ]\n    },\n    \"footer\": {\n      \"left_text_block\": {\n        \"headline\": \"{argument name=\\\"bottom headline\\\" default=\\\"体験は、構造から進化する。\\\"}\",\n        \"body\": \"一つひとつのパーツに、没入体験を支える最先端テクノロジーとこだわりの設計。Meta Quest 3は、未来を感じさせる体験を内部から生み出しています。\"\n      },\n      \"right_logo\": \"∞ Meta\"\n    }\n  }\n}",
    credit: null,
  },
  {
    slug: "fujifilm-portrait",
    title: "Fujifilm Strawberry School Portrait",
    model: "GPT Image 2",
    author: "@bubblebrain",
    kind: "image",
    asset: "portrait-fujifilm.jpg",
    poster: null,
    prompt: "9:16 vertical — Japanese Fuji film style portrait, single subject  Fujifilm analog aesthetic (Pro 400H / Superia feel), soft pastel tones, slight green-magenta shift, low contrast, gentle highlight roll-off, fine film grain, subtle halation, slight vignette  bright natural daylight, diffused sunlight through window, soft shadows, airy atmosphere  young Japanese female idol, natural minimal makeup, fresh glowing skin, realistic texture, slight imperfections  outfit: Japanese school uniform (sailor-style or blazer uniform), neatly styled, non-revealing, youthful and clean  hair: natural dark hair, straight or softly flowing, a few loose strands  pose: front-facing or slight angle toward camera, relaxed posture; one hand gently holding a strawberry near lips, mid-action as if about to take a bite; shoulders relaxed, subtle natural body curve  expression: soft playful gaze, light smile or neutral lips, gentle eye contact with camera  setting: minimal indoor near window or simple outdoor corner, clean background, everyday atmosphere  composition: slightly off-center framing, intimate distance, candid feel  mood: fresh, youthful, sweet everyday moment, understated charm  quality: ultra-realistic, analog film look, natural imperfections, soft dreamy finish",
    credit: null,
  },
  {
    slug: "streetwear",
    title: "Streetwear Fashion Campaign",
    model: "GPT Image 2",
    author: "@harboriis",
    kind: "image",
    asset: "poster-streetwear.jpg",
    poster: null,
    prompt: "Create a premium streetwear fashion campaign poster inspired by modern Asian apparel advertising. Full body portrait of a stylish young male model standing confidently with legs crossed at the ankles, hands inside jacket pockets, head turned slightly upward and sideways with a calm thoughtful expression. Curly tousled medium length hair with soft volume. Slim athletic build.\n\nOutfit includes a dark olive green padded hooded jacket worn open, clean white crewneck sweatshirt underneath with a tiny chest logo, relaxed black cargo style trousers, and minimal white sneakers. Styling is clean, youthful, and contemporary.\n\nBackground is a vibrant electric blue seamless studio backdrop with subtle gradient lighting, soft glow streaks, and glossy floor reflection. Lighting is soft studio light with gentle shadows and polished commercial finish.\n\nGraphic poster layout with giant bold condensed sans serif text reading “JEANSWEST” vertically stretched across the background behind the model in light gray white. Add large text on lower right reading “JW26”. \n\nComposition should feel premium, trendy, clean, commercial, youthful, modern fashion ad campaign. Sharp focus, ultra realistic fabric texture, cinematic lighting, balanced negative space, sleek branding design, high resolution, vertical poster ratio.",
    credit: null,
  },
  {
    slug: "ai-comparison",
    title: "Cyberpunk AI Tools Comparison Poster",
    model: "GPT Image 2",
    author: "@movehiro1219",
    kind: "image",
    asset: "poster-ai-comparison.jpg",
    poster: null,
    prompt: "A futuristic Japanese tech comparison poster in a dark cyberpunk control-room setting, wide 16:9 composition. Large distressed white Japanese headline text at the upper left reading \"三つ巴\", with a bold gold subtitle directly below reading \"それぞれの武器\". Across the center-left are 3 glowing holographic comparison panels arranged horizontally and connected by neon arrows: a blue panel labeled \"Google\", an amber-gold panel labeled \"Claude\", and a purple-magenta panel labeled \"OpenAI\". The Google panel contains 4 inner cards: 2 larger top cards labeled \"Gemini\" and \"Antigravity\", plus 2 smaller bottom cards showing analytics/dashboard-like visuals and a blue isometric cube graphic. The Claude panel contains 4 inner cards: 1 large top card labeled \"Claude Code\", plus 3 smaller bottom cards showing a network diagram, text/code list, and chart analytics. The OpenAI panel contains 5 inner cards: 2 larger top cards labeled \"ChatGPT\" and \"Codex\", plus 3 smaller bottom cards showing interface/code windows and a geometric wireframe cube. Add glowing bidirectional arrows between Google and Claude, and between Claude and OpenAI. At the bottom center, place a large neon-framed banner with gold text reading \"Google / Claude / OpenAI\". On the right side, include a young woman standing and pointing left toward the panels, with long straight split-dyed hair in pastel pink and cyan blue, a plain white t-shirt with black text reading \"{argument name=\"shirt text\" default=\"OKIHIRO AI Creative\"}\", and a soft pink pleated skirt. Her face is obscured by a smooth rectangular blur block. Use cinematic sci-fi lighting, glossy hologram UI details, high contrast, vivid blue-gold-purple accents, and a polished YouTube thumbnail aesthetic.",
    credit: null,
  },
  {
    slug: "poster-zodiac-fire",
    title: "Fire Sign Zodiac Character Poster",
    model: "GPT Image 2",
    author: "@komorimedia",
    kind: "image",
    asset: "poster-zodiac-fire.jpg",
    poster: null,
    prompt: "A polished vertical infographic poster in elegant East Asian editorial style, themed around the fire signs of the zodiac using one consistent female character reimagined in three different costumes. Cream parchment background with thin ornamental borders, small corner flourishes, tiny sparkles, and warm red-orange-gold accents throughout. Large Chinese headline at the top reading {argument name=\"headline text\" default=\"十二星座角色清單|火象星座\"}, with a smaller subheading beneath reading {argument name=\"subheading text\" default=\"熱情・行動・勇氣\"}, and a decorative flame icon at the top right. The layout contains exactly 3 stacked profile panels with rounded rectangular borders and generous margins: Aries on top, Leo in the middle, Sagittarius on the bottom. Each panel is split visually with the character on the left and a text/spec area on the right, plus a zodiac symbol badge on the far left and a small constellation diagram on the far right.\n\nUse the same young East Asian woman in all 3 panels, slim build, long dark hair in a high ponytail, shown from about thigh-up to waist-up, facing slightly toward camera, styled as a fashion-model zodiac character sheet. Keep facial features neutral and refined, clean beauty lighting, soft airbrushed illustration-photo composite look.\n\nPanel 1: Aries. Chinese title and English subtitle: \"牡羊座 Aries\". Dominant color scheme: vivid red with warm coral highlights. Zodiac symbol badge shows Aries glyph. Constellation on the right. Behind the character, faint circular mystical line art and flame motifs. Outfit: sporty warrior idol styling with a white crop top, red open short-sleeve jacket with gold trim, red belt, and red wrist wraps or fingerless arm accessories. Pose: confident, energetic, one fist raised near the shoulder and the other hand on her hip. Include exactly 6 info lines with small circular icons before each line, all in Chinese: 1) \"元素:火\" 2) \"概念:點火者,直覺先行\" 3) \"性格:熱情、直接、好勝\" 4) \"行動原則:先衝再修正\" 5) \"戀愛傾向:心動就追,喜歡熱烈互動\" 6) \"人際怪癖:嫌節奏太慢時會自己接手\".\n\nPanel 2: Leo. Chinese title and English subtitle: \"獅子座 Leo\". Dominant color scheme: gold, champagne, and soft amber. Zodiac symbol badge shows Leo glyph. Constellation on the right. Background includes radiant sunburst styling and a faint majestic lion illustration silhouette behind the character. Outfit: glamorous regal gown in pale gold with ornate embroidery, jeweled bodice details, flowing translucent cape sleeves, elegant necklace, and a small crown or tiara. Pose: poised and queenly, one hand lightly touching the chest or collarbone, shoulders open, projecting confidence and star power. Include exactly 6 info lines with small circular icons before each line, all in Chinese: 1) \"元素:火\" 2) \"概念:舞台中心,自帶光芒\" 3) \"性格:大方、自信、要面子\" 4) \"行動原則:先定氣場,再帶隊前進\" 5) \"戀愛傾向:喜歡被偏愛,也樂於寵人\" 6) \"人際怪癖:明明在意,卻要裝沒事\".\n\nPanel 3: Sagittarius. Chinese title and English subtitle: \"射手座 Sagittarius\". Dominant color scheme: rust red, burnt orange, brown leather, and warm ivory. Zodiac symbol badge shows Sagittarius glyph. Constellation on the right. Background features faint compass-circle graphics and flame accents. Outfit: adventurous archer styling with an ivory blouse, red scarf, brown leather harness straps, utility belt, and arm bracers. Pose: dynamic action shot drawing a bow, arrow aimed to the right, with a small glowing spark at the bow grip or arrow rest. Include exactly 6 info lines with small circular icons before each line, all in Chinese: 1) \"元素:火\" 2) \"概念:自由旅人,邊走邊發現\" 3) \"性格:樂觀、坦率、好奇\" 4) \"行動原則:先出發,路上再找答案\" 5) \"戀愛傾向:喜歡輕鬆真誠,不愛被綁住\" 6) \"人際怪癖:聊到一半常被新鮮事帶走\".\n\nOverall design should feel premium, feminine, mystical, and collectible, like a social-media-ready zodiac character list poster. Use elegant serif-style Chinese typography for the main sign names and italic calligraphic English for Aries, Leo, and Sagittarius. Keep all text crisp, aligned, and readable. Add one small decorative fire emblem centered near the bottom border. Aspect ratio 3:4 portrait.",
    credit: null,
  },
  {
    slug: "storyboard-gas-giant",
    title: "Gas Giant Descent Storyboard",
    model: "GPT Image 2",
    author: "@xrahultripathi",
    kind: "image",
    asset: "storyboard-gas-giant.jpg",
    poster: null,
    prompt: "{\"type\":\"cinematic sci-fi storyboard contact sheet\",\"subject\":{\"primary\":\"a small futuristic spacecraft descending into a massive gas giant storm system\",\"secondary\":\"an enormous leviathan-like silhouette hidden within the clouds\",\"mood\":\"oppressive, catastrophic, awe-struck, high tension, cosmic dread\",\"style\":\"photorealistic cinematic concept art with dark sci-fi realism, volumetric storm clouds, strong contrast, amber and black palette with occasional cold blue lightning\",\"aspect_ratio\":\"16:9\"},\"vehicle\":{\"design\":\"compact armored deep-atmosphere ship with 3 bright rear engines, angular industrial hull, worn metallic panels\",\"scale\":\"tiny compared to the planet and creature\"},\"layout\":{\"grid\":{\"rows\":3,\"columns\":4,\"count\":12},\"sections\":[{\"position\":\"row 1 col 1\",\"description\":\"wide exterior shot of the ship entering the upper atmosphere of a colossal gas giant at extreme speed, glowing clouds streaked with fire and friction around the vessel, curved planetary horizon visible\"},{\"position\":\"row 1 col 2\",\"description\":\"cockpit POV, dark interior filled with red and cyan holographic instruments, forward visibility collapsing into turbulent storm layers and electrical haze\"},{\"position\":\"row 1 col 3\",\"description\":\"exterior mid-wide shot of the ship diving into a gigantic rotating cloud funnel, surrounded by violent spiraling storm structure\"},{\"position\":\"row 1 col 4\",\"description\":\"extreme close exterior of the ship hull as bright lightning strikes dangerously close, white electric energy crawling across the metal surface\"},{\"position\":\"row 2 col 1\",\"description\":\"dashboard warning screen in red, showing a critical systems failure interface with the exact visible text count of 4 warning lines and 1 large percentage readout: ['WARNING','ENGINES COMPROMISED','THRUST FLUCTUATION','GRAVITY SPIKE DETECTED','DESCENT RATE -453%']\"},{\"position\":\"row 2 col 2\",\"description\":\"rear three-quarter exterior of the ship fighting turbulence inside dense storm clouds, engines burning hard while the craft barely holds course\"},{\"position\":\"row 2 col 3\",\"description\":\"massive circular disturbance forming in the clouds like an eye or maw, entire storm systems displaced by something huge moving beneath\"},{\"position\":\"row 2 col 4\",\"description\":\"second cockpit view with radar-like navigation display and red alert text, pilot making a blind evasive maneuver through lightning-filled darkness\"},{\"position\":\"row 3 col 1\",\"description\":\"first reveal of the colossal creature shape rising near the ship, black organic surface and immense curved anatomy emerging from darkness, ship tiny at lower left\"},{\"position\":\"row 3 col 2\",\"description\":\"spiral descent shot, ship caught inside a vortex tunnel of clouds, spinning downward with engines flaring as it struggles to recover\"},{\"position\":\"row 3 col 3\",\"description\":\"sudden breakthrough into a calm void, minimal composition, ship flying in eerie silence through dark open space with soft mist and no visible storm around it\"},{\"position\":\"row 3 col 4\",\"description\":\"final reveal, gigantic leviathan fully emerging behind or beside the ship in cleared space, backlit by a pale circular storm opening, enormous open maw-like silhouette dwarfing the craft\"}],\"continuity\":\"all 12 panels depict one continuous descent sequence from atmospheric entry to final creature reveal\"},\"lighting\":{\"primary\":\"glowing amber storm light\",\"secondary\":\"red cockpit interface glow\",\"accents\":\"blue-white lightning and engine exhaust\"},\"environment\":{\"location\":\"inside the upper and middle storm layers of a gigantic gas giant\",\"weather\":\"violent turbulence, electrical storms, vortex funnels, cloud walls, pressure chaos\",\"threat\":\"no safe zone, repeated near-failure, unknown colossal presence driving the storm\"}}",
    credit: null,
  },
  {
    slug: "poster-skyray-aircraft",
    title: "Biomimetic Skyray Aircraft Poster",
    model: "GPT Image 2",
    author: "@simonsmith",
    kind: "image",
    asset: "poster-skyray-aircraft.jpg",
    poster: null,
    prompt: "{\"type\":\"biomimetic aerospace concept poster\",\"subject\":{\"vehicle\":\"futuristic aircraft concept\",\"name\":\"{argument name=\\\"vehicle name\\\" default=\\\"SKYRAY\\\"}\",\"inspiration\":\"{argument name=\\\"animal inspiration\\\" default=\\\"stingray\\\"}\",\"design\":\"blended-wing-body aircraft shaped like a manta ray or stingray, wide triangular planform, smooth organic curves, sharp pointed nose, slightly raised central spine, tapered wing tips curling subtly upward, dark graphite-black metallic skin with fine panel lines and faint blue illuminated accents along edges and seams\"},\"style\":{\"mood\":\"premium futuristic industrial design presentation\",\"rendering\":\"hyper-detailed cinematic 3D concept art mixed with blueprint visualization\",\"color_palette\":\"black, charcoal, gunmetal, silver, deep ocean blue, electric cyan highlights\",\"lighting\":\"low-key dramatic studio lighting with glossy reflections, cool rim light, subtle underwater ambience in the top inspiration strip\"},\"layout\":{\"background\":\"full black poster with faint technical grid lines and soft vignetting\",\"sections\":[{\"title\":\"header\",\"position\":\"top\",\"count\":3,\"labels\":[\"emblem mark\",\"SKYRAY\",\"INSPIRED BY THE SEA. ENGINEERED FOR THE SKY.\"]},{\"title\":\"evolution strip\",\"position\":\"upper middle\",\"count\":5,\"labels\":[\"realistic stingray underwater at far left\",\"top-view biological stingray study\",\"abstract aerodynamic line sketch\",\"faceted aircraft blueprint transition drawing\",\"final sleek aircraft concept at far right\"]},{\"title\":\"hero render\",\"position\":\"center\",\"count\":1,\"labels\":[\"large three-quarter view of the aircraft\"]},{\"title\":\"technical views grid\",\"position\":\"lower middle\",\"count\":6,\"labels\":[\"TOP\",\"SIDE\",\"FRONT\",\"REAR\",\"UNDERSIDE\",\"DETAIL\"]},{\"title\":\"footer text\",\"position\":\"bottom\",\"count\":1,\"labels\":[\"{argument name=\\\"body text\\\" default=\\\"A biomimetic high-speed aircraft concept shaped by the hydrodynamic elegance of the stingray. Its blended wing body, low-drag silhouette, and fluid control surfaces translate ocean-born efficiency into atmospheric performance.\\\"}\"]}],\"technical views\":{\"TOP\":\"top orthographic view with measurement ticks\",\"SIDE\":\"thin side profile with long smooth belly curve\",\"FRONT\":\"front orthographic view emphasizing broad wingspan and central cockpit hump\",\"REAR\":\"rear orthographic view showing narrow tail end and wing sweep\",\"UNDERSIDE\":\"underside three-quarter view\",\"DETAIL\":\"close-up crop of metallic skin, seam lines, and glowing blue edge strip\"}},\"graphics\":{\"logo\":\"minimal four-point symmetrical emblem above title, resembling a stylized ray silhouette\",\"arrows\":\"4 thin cyan arrows connecting the 5 stages in the evolution strip\",\"typography\":\"widely spaced modern sans-serif uppercase text, clean luxury-tech branding\"},\"camera\":{\"hero render\":\"slightly elevated front-left three-quarter angle\",\"technical views\":\"orthographic\",\"inspiration image\":\"underwater side angle with light rays from above\"},\"quality\":\"ultra-clean, polished, high contrast, sharp, poster-ready, concept design board for aerospace branding or speculative industrial design\"}",
    credit: null,
  },
  {
    slug: "ecom-crocs",
    title: "E-commerce Main Image - Pastel Blue Crocs Fashion",
    model: "GPT Image 2",
    author: "@speedai07",
    kind: "image",
    asset: "ecom-crocs.jpg",
    poster: null,
    prompt: "A high-end studio advertising poster for {argument name=\"brand name\" default=\"crocs\"}, in a monochrome pastel blue and white color palette, with a glossy reflective floor and a soft sky-blue backdrop. The background is dominated by the word {argument name=\"headline text\" default=\"CROCS\"} in gigantic bold white condensed sans-serif letters spanning nearly the full height of the image. In the top-right corner, add small white text reading \"Designed with ChatGPT\". Feature 3 adult women with shoulder-length wavy light brown to dark blonde hair, all wearing loose oversized white long-sleeve tops and flowing white wide-leg pants, styled as minimalist fashion models with relaxed neutral expressions. Their faces are intentionally obscured or blurred. One model reclines against an enormous upright white clog shoe on the left side, one model sits casually on top of a giant white clog on the upper right, and one model lounges on the floor at the lower right, leaning back on one arm while seated partly on a glossy blue sphere. Include 2 oversized white clog shoes as hero props: one standing vertically on the left showing the sole and side profile, and one angled on blue crystalline blocks at center-right showing the upper and toe box. Both clogs are classic foam slip-on style with perforation holes, chunky tread, heel straps, and circular logo rivets. The center-right clog is decorated with exactly 8 visible charms pinned to the upper: a blue-green iridescent round charm, a white daisy with yellow center, a black-and-white round emblem near the strap, a small \"CROCS\" word charm, a dark flower, a peace-hand sign, an orange smiley face, a white cloud, and an orange flower. Scatter exactly 7 glossy floating or grounded blue spheres of varying sizes around the set: one large sphere behind the left model, one medium sphere floating near center, one medium sphere at bottom left foreground, one medium sphere used as a seat under the lower-right model, one small sphere near the upper left, and 2 additional blue spheres integrated into the composition. Add translucent sculptural gel-like forms at the far left and far right edges, plus angular blue crystal-like rocks beneath the right shoe. At the bottom center, place white promotional copy in a clean sans-serif font: {argument name=\"tagline line 1\" default=\"Made for comfort, worn for confidence.\"} on the first line and {argument name=\"tagline line 2\" default=\"Because life feels better when your feet stop complaining.\"} on the second line. Beneath that, show 4 minimalist feature icons with labels in white: \"ICONIC COMFORT\", \"LIGHTWEIGHT\", \"EASY TO CLEAN\", and \"UNIQUELY YOU\". Place the {argument name=\"logo text\" default=\"crocs\"} logo in bold lowercase white at the bottom center with a small trademark symbol. The overall style should feel like a premium surreal fashion campaign, clean editorial lighting, soft shadows, glossy textures, airy composition, and modern lifestyle product advertising.",
    credit: null,
  },
  {
    slug: "poster-alishan-travel",
    title: "Alishan One-Day Travel Poster",
    model: "GPT Image 2",
    author: "@twnese",
    kind: "image",
    asset: "poster-alishan-travel.jpg",
    poster: null,
    prompt: "Create a vintage illustrated travel poster in traditional Chinese for {argument name=\"destination name\" default=\"阿里山國家風景區\"}, designed as a one-day itinerary infographic with a split vertical layout. The left panel is a parchment-textured itinerary card in warm beige with ornate gold Art Nouveau borders and dark brown typography, and the right panel is a dramatic painted fantasy-realism map scene of a mountain journey at sunrise and sunset tones. At the top of the left panel, large headline text reads {argument name=\"headline text\" default=\"阿里山國家風景區一日遊\"}. Beneath it, include a short centered tagline in traditional Chinese: 「一座高山,五個經典景點。難忘的奇幻旅程。」 with a small decorative mountain divider. The left panel must contain exactly 5 numbered itinerary stops stacked vertically, each with a circular black-and-gold number badge, a small vignette illustration, a bold location name, a time in parentheses, and a short Chinese description. The 5 stops are: 1. 「阿里山車站」 at 「(8:00 AM)」 with a wooden mountain railway station illustration and description 「開啟探索神木與森林的旅程。」 2. 「阿里山森林鐵路」 at 「(9:30 AM)」 with a red-and-black steam train illustration and description 「穿越森林,體驗百年林鐵風情。」 3. 「神木區棧道」 at 「(11:30 AM)」 with giant cedar trees and elevated wooden boardwalk illustration and description 「漫步千年巨木下,感受森林靈氣。」 4. 「姊妹潭」 at 「(1:30 PM)」 with a tranquil forest lake and pavilion illustration and description 「欣賞靜謐湖光,聆聽自然樂章。」 5. 「小笠原山展望台」 at 「(4:00 PM)」 with a wooden observation deck above clouds at sunset illustration and description 「觀賞壯闊山景與雲海,欣賞日落。」 The right panel should depict a continuous glowing golden path winding through exactly 5 numbered map markers that match the left panel labels in order, with black-and-gold marker plaques reading: 1 「阿里山車站」, 2 「阿里山森林鐵路」, 3 「神木區棧道」, 4 「姊妹潭」, 5 「小笠原山展望台」. Show stop 1 as a rustic alpine wooden station perched on a cliff among pine forests; stop 2 as a small steam locomotive traveling on a curved mountain railway with smoke drifting upward; stop 3 as towering ancient red cypress trees with a spiral and zigzag wooden walkway around the trunks; stop 4 as an emerald lake surrounded by dense forest with a small pavilion and arched bridge; stop 5 as a lookout deck on a peak above a sea of clouds, facing a glowing sunset. The environment should feature layered mountain ranges, mist-filled valleys, evergreen forests, golden-hour light, luminous cloud seas, and a romantic painterly atmosphere with rich detail. At the bottom right, add a decorative compass rose labeled N, E, S, W, plus a dark green and gold information box with exactly 2 stats in traditional Chinese: 「總距離 ~9公里 / 5.6英里」 and 「預計時間 全天 - 14,500步」. Overall style: premium tourism poster, painterly digital illustration, nostalgic national-park brochure aesthetic, highly detailed, warm sepia and gold accents, elegant composition, readable Chinese text, vertical 2:3 poster.",
    credit: null,
  },
  {
    slug: "portrait-muse-night",
    title: "Artist and Ethereal Muse at Night",
    model: "GPT Image 2",
    author: "@almimeister",
    kind: "image",
    asset: "portrait-muse-night.jpg",
    poster: null,
    prompt: "A cinematic anime-inspired digital illustration set at night inside a cozy artist's room with large window panes and a warm city glow outside. On the left, a young male artist with {argument name=\"hair color\" default=\"dark brown\"} messy hair sits at a cluttered desk in side profile, leaning forward with one hand near his mouth and the other drawing with a pen on a tablet or sketchbook. The desk is covered with exactly 1 pen cup filled with pencils, 1 coffee mug, 1 open laptop or pen-display showing a sunset landscape, 1 spiral sketchbook with manga-style character drawings, 2 additional drawing books or pads, 1 small stack of about 4 books, and many scattered art cards and printed illustrations. On the right, a luminous ethereal anime girl made of blue-white light appears life-sized, facing the artist with both hands gently extended toward him. Her form is translucent, delicate, and composed of glowing contour lines, starry particles, and flowing strands of light, with long windblown hair and a soft dress-like silhouette. Between them, a magical stream of golden and white light spirals upward from the artist's desk into the air, connecting creator and creation. Inside this swirling ribbon are exactly 12 to 16 floating image fragments and sketch pages: monochrome character sketches, scenic sunset paintings, small photo-like panels, and tiny icon-like cards, all orbiting in a curved arc from lower center to upper left and upper center. Around the upper half of the image, dozens of glowing musical notes float through the air, mixed with sparkling particles, creating the feeling that inspiration has become visible sound and memory. The palette is rich warm gold and amber on the artist's side, contrasted with cool electric blue and white on the spirit girl's side, with dramatic rim light, volumetric glow, intricate particles, and a dreamy emotional atmosphere. Composition is vertical, highly detailed, intimate, and poetic, evoking the relationship between {argument name=\"person one\" default=\"you\"} and {argument name=\"person two\" default=\"me\"} as artist and imagined muse, where drawings, music, memories, and fantasy physically manifest in the room. Add a small handwritten note card on the desk with {argument name=\"note text\" default=\"二人だけの物語\"}, and display one prominent artwork on the desk and one floating scenic panel using {argument name=\"scene theme\" default=\"sunset sky over a distant city\"}.",
    credit: null,
  },
  {
    slug: "portrait-35mm-editorial",
    title: "35mm Flash Editorial Portrait",
    model: "GPT Image 2",
    author: "@bubblebrain",
    kind: "image",
    asset: "portrait-35mm-editorial.jpg",
    poster: null,
    prompt: "35mm color film photography with harsh direct on-camera flash, specular highlights on skin and clothing, strong catchlights in eyes, high contrast flash illumination, authentic film grain and color shift, high fashion fresh innocent basketball court editorial style, intimate first-person low-angle POV shot from below, early 20s sexy Chinese female idol with ultra-realistic delicate refined Chinese features, seductive almond-shaped fox eyes with natural double eyelids, high nose bridge, small sharp V-shaped jawline, flawless realistic porcelain skin with cool ivory undertone and visible flash specular highlights, fine delicate skin texture with subtle pores micro details and natural dewy glow under flash, fresh natural sporty makeup with soft dewy glow, subtle natural flush on cheeks, natural pink lips slightly parted, subtle natural freckles across nose and cheeks, long dark brown hair tied in a high playful ponytail with some loose strands framing the face and realistic loose strands, wearing a loose white tank top and white high-waisted basketball shorts, white knee-high sports socks, seductive natural leaning pose against the basketball hoop pole on the outdoor court at dusk, body angled sideways with naturally arched back and hips gently pushed back to accentuate perky round hips and sexy butt curve, one leg naturally extended forward toward the camera and the other leg slightly bent to emphasize long sexy legs, both hands lightly resting on the basketball pole at shoulder height, intensely seductive playful yet pitiable doe-eyed gaze straight at the viewer with soft vulnerable longing eyes and a gentle teasing smile full of quiet temptation and desire, harsh direct on-camera flash creating sharp specular highlights and strong catchlights, background with blurred basketball court and hoop under dusk sky, high contrast film color grading with natural flash look, extremely sharp yet soft skin rendering with authentic 35mm direct flash aesthetic, natural hair strands, realistic fabric texture on tank top and shorts with socks detail, no plastic skin, no digital over-sharpening, no airbrushing, no blemishes, no moles, no oily skin, no watermark, no text, authentic 35mm direct flash film basketball court look --ar 9:16",
    credit: null,
  },
  {
    slug: "poster-sneaker-streetwear",
    title: "Streetwear Sneaker Poster Ad",
    model: "GPT Image 2",
    author: "@alwavenazca",
    kind: "image",
    asset: "poster-sneaker-streetwear.jpg",
    poster: null,
    prompt: "Create a bold streetwear poster advertisement for {argument name=\"brand name\" default=\"NESS STUDIO\"} featuring a young adult model seated casually on the ground in a low-angle fashion pose, one knee raised and one leg extended toward the camera so the sneaker in front appears oversized and dominant. The model wears a dark brown oversized leather bomber jacket, a black shirt, light blue loose-fit jeans, white socks, and chunky black-white-gray sneakers with a red accent in the sole and the {argument name=\"brand name\" default=\"NESS STUDIO\"} logo visible on the shoe side and tongue. The face is intentionally obscured by a soft rectangular blur block centered over the face. Use an off-white textured paper background with distressed grunge design elements and collage layering. Behind the model, place a large rough red paint brushstroke shape spanning diagonally across the center. Add black ink splatters, sketch circles, torn paper scraps, and hand-painted graffiti accents. Include 4 major graphic doodles: a large black X in the upper right, a hand-drawn upward arrow in the lower left, a rough crown sketch in the lower right, and a circular scribble near the top center. In the upper left, place a stylized eye logo above the text \"{argument name=\"brand name\" default=\"NESS STUDIO\"}\" and a smaller tagline below reading \"A MOMENT OF YOUR STYLE\". On the left middle area, add the handwritten slogan \"INNOVATE CREATE INSPIRE\" in stacked black brush lettering. On the right middle area, place a torn black paper patch with the handwritten white slogan \"BUILT DIFFERENT MOVE DIFFERENT\" and a red underline stroke. In the lower left near the shoe, add a black distressed label sticker containing a globe scribble, the text \"{argument name=\"brand name\" default=\"NESS STUDIO\"}\", and a barcode. Along the bottom footer, create a clean horizontal strip with 3 social media icons and handles separated by thin vertical dividers: Instagram, Facebook, and Twitter, each followed by \"@NESS.STUDIO\". The overall style should be edgy, urban, youthful, high-contrast, editorial street fashion, mixing product advertising photography with graffiti poster design, collage textures, and dynamic branding.",
    credit: null,
  },
  {
    slug: "poster-momos-ad",
    title: "Cinematic Chicken Momos Ad Poster",
    model: "GPT Image 2",
    author: "@diplomeme",
    kind: "image",
    asset: "poster-momos-ad.jpg",
    poster: null,
    prompt: "A hyper-realistic cinematic street-food advertisement poster for {argument name=\"brand name\" default=\"Licious\"} frozen {argument name=\"product name\" default=\"Chicken Momos\"}, shot in a dark premium studio with dramatic moody lighting, deep navy-black background, glossy black tabletop, and high contrast commercial food photography styling. The composition is a square social-media ad layout with oversized bold condensed white sans-serif headline text on the left reading {argument name=\"headline text\" default=\"PERFECTLY MADE.\"} stacked across two lines, and a smaller white subheadline beneath it reading {argument name=\"tagline text\" default=\"PRECISION IN EVERY BITE.\"}. Along the far left edge, add thin vertical small caps text reading “FRESH • CLEAN • CONTROLLED”. Across the upper-right background, repeat the phrase “CUT / STEAM / SERVE / REPEAT” in a subtle dark gray pattern, and faintly repeat “CUT / STEAM / SERVE / REPEAT” again near the bottom-left floor area as perspective text. Feature exactly 6 momos total: 5 intact steamed chicken momos floating and arranged dynamically across the center and right side, and 1 split-open momo in the center revealing juicy orange-brown chicken filling with herbs, with a glossy red-orange sauce droplet dripping downward from the opened dumpling. Scatter small chili flakes, herb bits, and seasoning particles suspended in the air around the momos for explosive motion. Place exactly 3 retail product boxes on the right side, staggered in depth, black packaging with the {argument name=\"brand name\" default=\"Licious\"} logo and red product title “CHICKEN MOMOS,” including food photography of the dumplings on the box front. At the bottom right foreground, place 1 small black bowl filled with bright red dipping sauce. Add a thin footer line of small white text across the bottom reading “CHICKEN MOMOS • FRESHLY PREPARED • 2026 EDITION” and place “licious.com” in the lower-right corner. Use premium ad design, ultra-detailed food texture, glossy highlights on the dumplings, subtle steam sheen, crisp typography, shallow depth of field, and a polished high-end commercial campaign aesthetic.",
    credit: null,
  },
  {
    slug: "portrait-idol-collage",
    title: "Korean Idol 3x3 Collage Portrait",
    model: "GPT Image 2",
    author: "@bubblebrain",
    kind: "image",
    asset: "portrait-idol-collage.jpg",
    poster: null,
    prompt: "9:16 vertical — a 3x3 grid collage (nine images) forming a Korean idol portrait photoshoot series. Each frame features the same young Korean female idol, maintaining 100% consistency in facial features, proportions, hairstyle, and identity across all nine shots.   Natural, ultra-realistic skin texture, no retouching, no smoothing. Clean idol-style minimal makeup, soft glow, subtle imperfections.   Hair: long, voluminous dark hair, slightly tousled, consistent across all frames (natural loose flow, slight movement).  Outfit: cohesive Korean idol photoshoot styling — white shirt + short bottoms (or simple neutral-toned outfit), youthful, clean, slightly casual but styled. Same outfit across all frames.  Setting: minimal studio or simple indoor environment (plain wall, soft window light, clean background). Focus on subject, not environment.  Lighting: soft diffused natural light, gentle highlights, low contrast, slightly airy tones, subtle film-like softness.  Camera style: intimate portrait photography, slightly handheld feel, subtle imperfections (minor grain, slight blur in motion frames, imperfect framing).  Frame breakdown (3x3 grid):  Top row: - Top left: standing naturally, looking slightly away, relaxed expression - Top center: facing camera, casual mid-motion (hair or body slight movement) - Top right: slight side angle, soft gaze, natural candid feel  Middle row: - Center left: looking slightly upward, soft thoughtful expression - Center: close-up portrait, direct eye contact, gentle idol smile - Center right: turning body slightly, mid-motion candid frame  Bottom row: - Bottom left: seated or leaning casually, relaxed posture - Bottom center: back partially turned, looking over shoulder toward camera - Bottom right: standing close to frame, slightly playful or soft expression  Mood: Korean idol photobook / photocard aesthetic, intimate, soft, natural, everyday charm.  Quality: ultra-realistic, 8K detail, subtle analog film grain, natural imperfections, soft dreamy tone",
    credit: null,
  },
  {
    slug: "ecom-tshirt",
    title: "E-commerce Main Image - Sustainable T-Shirt Plant",
    model: "GPT Image 2",
    author: "@diplomeme",
    kind: "image",
    asset: "ecom-tshirt.jpg",
    poster: null,
    prompt: "A premium eco-conscious fashion advertisement, shot as a refined editorial product photo. A single off-white or natural cream crew-neck T-shirt hangs on a smooth wooden hanger with a black metal hook, placed against a lush wall of dense green leaves and climbing vines. The hanger has a small minimalist brand monogram engraved near the neck. The shirt is shown from the upper torso down to part of the hem, slightly angled, with soft natural folds and high-quality cotton texture. Printed inside the collar is a minimalist brand mark and the text \"JUGGERKNOT ORIGINALS\". Hanging from the neckline is 1 rectangular recycled-paper seed tag tied with rustic brown twine; the tag reads \"Tulsi\" and \"Plantable Seed Tag\" with a tiny sprouting seed detail near the bottom. From the tag, 1 real tulsi plant stem grows upward across the front of the shirt, with several fresh green leaves, visually demonstrating that the tag is plantable. Add a small fine-label annotation near the tag reading \"TULSI PLANTABLE SEED TAG\". On the right side, large elegant white serif typography says {argument name=\"headline text\" default=\"Plant it.\"}. Beneath it, place 3 stacked lines of narrow uppercase sans-serif copy: \"WEAR IT.\", \"PLANT IT.\", and \"GROW WITH IT.\". At the lower left, add the brand name in spaced uppercase serif text: {argument name=\"brand name\" default=\"JUGGERKNOT ORIGINALS\"}, with a thin horizontal line above it. At the lower right, add 3 lines of small uppercase sans-serif text: \"FSC® CERTIFIED PACKAGING.\", \"ZERO SYNTHETIC FIBRE\", and \"BACKED BY ZERODHA.\". Use soft diffused daylight, shallow depth of field, moody green-and-cream color grading, luxury sustainable-brand aesthetics, clean composition, vertical poster layout, subtle shadows, and a calm organic atmosphere. Keep the design minimal, premium, and photorealistic, with the shirt occupying the left half and the typography balanced on the right.",
    credit: null,
  },
  {
    slug: "char-lavender-anime",
    title: "Pastel Lavender Anime Girl Portrait",
    model: "GPT Image 2",
    author: "@libearal",
    kind: "image",
    asset: "char-lavender-anime.jpg",
    poster: null,
    prompt: "A delicate vertical anime portrait of a dreamy young woman in an ethereal pastel lavender palette, shown from about mid-thigh up against a soft decorative background of pale swirling lines, floating petals, tiny stars, and subtle sparkles. She has extremely long, voluminous silver-lilac hair styled in twin tails with flowing strands, soft bangs, and ornate ribbon decorations; each side is adorned with large lavender bows, ruffled headband-like trim, dangling gold star charms, and small white flower hair ornaments. Her face is centered and mostly covered by a flat solid pale lavender rectangle censor block, leaving only hints of her ears and hairline visible. She wears an elaborate fantasy-lolita inspired dress in white, pearl, and light violet, with glossy satin fabric, ruffled neckline, layered frills, puffed detached sleeves, gold trim, corset lacing at the waist, and multiple purple bows including 3 clearly visible bow accents on the outfit. Her hands are clasped gently near her chest in a shy, elegant pose. The image should feel soft, refined, feminine, and luminous, with high-detail anime rendering, smooth gradients, airy composition, flowing hair movement, and a romantic celestial aesthetic. Use a {argument name=\"color theme\" default=\"pastel lavender and white\"} palette, {argument name=\"hair color\" default=\"silver-lilac\"} hair, an {argument name=\"outfit style\" default=\"ornate fantasy lolita dress with bows and ruffles\"} design, a {argument name=\"background style\" default=\"soft swirls, petals, stars, and sparkles\"} backdrop, and a {argument name=\"face covering\" default=\"solid pale lavender censor rectangle\"} over the face.",
    credit: null,
  },
  {
    slug: "launch-film-1",
    title: "Franklin Launch Film — Push-In",
    model: "SeeDance",
    author: null,
    kind: "image",
    asset: "launch-film-01-front-pushin-early.jpg",
    poster: null,
    prompt: null,
    credit: null,
  },
  {
    slug: "launch-film-2",
    title: "Franklin Launch Film — Reveal",
    model: "SeeDance",
    author: null,
    kind: "image",
    asset: "launch-film-02-front-pushin-late.jpg",
    poster: null,
    prompt: null,
    credit: null,
  },
  {
    slug: "launch-film-3",
    title: "Franklin Launch Film — Terminal",
    model: "SeeDance",
    author: null,
    kind: "image",
    asset: "launch-film-03-terminal-camera.jpg",
    poster: null,
    prompt: null,
    credit: null,
  },
  {
    slug: "launch-film-4",
    title: "Franklin Launch Film — Finish",
    model: "SeeDance",
    author: null,
    kind: "image",
    asset: "launch-film-04-cinematic-finish.jpg",
    poster: null,
    prompt: null,
    credit: null,
  },
]
