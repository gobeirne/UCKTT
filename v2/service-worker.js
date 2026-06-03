const CACHE_NAME = "uc4afc-cache-v1";

// You can automate this with a build step later
const ASSETS_TO_CACHE = [
  "./index.html",
  "./config.json",
  "./manifest.json",
  "./UC4AFC_lists.txt",
  "./arrowFiles.json",

  // JS modules
  "./global.js",
  "./config.js",
  "./ui.js",
  "./setImage.js",
  "./flow.js",
  "./list.js",
  "./preload.js",
  "./results.js",
  "./main.js",

  // Images (add more as needed or automate)
"./images/back.jpg",
"./images/bag.jpg",
"./images/ball.jpg",
"./images/bat.jpg",
"./images/bat_backup.jpg",
"./images/beach.jpg",
"./images/beak.jpg",
"./images/beak_arrow.jpg",
"./images/bed.jpg",
"./images/bell.jpg",
"./images/bike.jpg",
"./images/bin.jpg",
"./images/bird.jpg",
"./images/bite.jpg",
"./images/boat.jpg",
"./images/bone.jpg",
"./images/book.jpg",
"./images/boot.jpg",
"./images/bug.jpg",
"./images/bus.jpg",
"./images/cage.jpg",
"./images/cake.jpg",
"./images/cap.jpg",
"./images/card.jpg",
"./images/cat.jpg",
"./images/chalk.jpg",
"./images/chin.jpg",
"./images/chin_arrow.jpg",
"./images/chip.jpg",
"./images/coat.jpg",
"./images/comb.jpg",
"./images/cone.jpg",
"./images/cot.jpg",
"./images/cot_backup.jpg",
"./images/dad.jpg",
"./images/dad_arrow.jpg",
"./images/dirt.jpg",
"./images/dog.jpg",
"./images/duck.jpg",
"./images/fan.jpg",
"./images/feet.jpg",
"./images/fork.jpg",
"./images/gate.jpg",
"./images/goat.jpg",
"./images/hall.jpg",
"./images/hat.jpg",
"./images/head.jpg",
"./images/head_backup.jpg",
"./images/heart.jpg",
"./images/hen.jpg",
"./images/hood.jpg",
"./images/hood_arrow.jpg",
"./images/house.jpg",
"./images/hug.jpg",
"./images/hut.jpg",
"./images/keys.jpg",
"./images/king.jpg",
"./images/kite.jpg",
"./images/knees.jpg",
"./images/knees_arrow.jpg",
"./images/knife.jpg",
"./images/leaf.jpg",
"./images/leg.jpg",
"./images/lick.jpg",
"./images/light.jpg",
"./images/lock.jpg",
"./images/lock_arrow.jpg",
"./images/log.jpg",
"./images/man.jpg",
"./images/meat.jpg",
"./images/mop.jpg",
"./images/mouse.jpg",
"./images/mouth.jpg",
"./images/mum.jpg",
"./images/mum_arrow.jpg",
"./images/night.jpg",
"./images/nose.jpg",
"./images/nose_arrow.jpg",
"./images/note.jpg",
"./images/note_arrow.jpg",
"./images/nurse.jpg",
"./images/nurse_backup.jpg",
"./images/nut.jpg",
"./images/page.jpg",
"./images/page_arrow.jpg",
"./images/pan.jpg",
"./images/park.jpg",
"./images/peach.jpg",
"./images/peach_backup.jpg",
"./images/pen.jpg",
"./images/pig.jpg",
"./images/purse.jpg",
"./images/road.jpg",
"./images/rock.jpg",
"./images/rose.jpg",
"./images/rug.jpg",
"./images/sack.jpg",
"./images/sad.jpg",
"./images/seed.jpg",
"./images/seed_arrow.jpg",
"./images/shark.jpg",
"./images/sheep.jpg",
"./images/sheep_backup.jpg",
"./images/shell.jpg",
"./images/ship.jpg",
"./images/shirt.jpg",
"./images/shop.jpg",
"./images/sock.jpg",
"./images/soup.jpg",
"./images/suit.jpg",
"./images/sword.jpg",
"./images/tap.jpg",
"./images/tongue.jpg",
"./images/tongue_arrow.jpg",
"./images/van.jpg",
"./images/zip.jpg",
  // Sounds
"./sounds/back.mp3",
"./sounds/bag.mp3",
"./sounds/ball.mp3",
"./sounds/bat.mp3",
"./sounds/beach.mp3",
"./sounds/beak.mp3",
"./sounds/bed.mp3",
"./sounds/bell.mp3",
"./sounds/bike.mp3",
"./sounds/bin.mp3",
"./sounds/bird.mp3",
"./sounds/bite.mp3",
"./sounds/boat.mp3",
"./sounds/bone.mp3",
"./sounds/book.mp3",
"./sounds/boot.mp3",
"./sounds/bug.mp3",
"./sounds/bus.mp3",
"./sounds/cage.mp3",
"./sounds/cake.mp3",
"./sounds/calib.mp3",
"./sounds/cap.mp3",
"./sounds/card.mp3",
"./sounds/cat.mp3",
"./sounds/chalk.mp3",
"./sounds/chin.mp3",
"./sounds/chip.mp3",
"./sounds/coat.mp3",
"./sounds/comb.mp3",
"./sounds/cone.mp3",
"./sounds/cot.mp3",
"./sounds/dad.mp3",
"./sounds/dirt.mp3",
"./sounds/dog.mp3",
"./sounds/duck.mp3",
"./sounds/fan.mp3",
"./sounds/feet.mp3",
"./sounds/fork.mp3",
"./sounds/gate.mp3",
"./sounds/goat.mp3",
"./sounds/hall.mp3",
"./sounds/hat.mp3",
"./sounds/head.mp3",
"./sounds/heart.mp3",
"./sounds/hen.mp3",
"./sounds/hood.mp3",
"./sounds/house.mp3",
"./sounds/hug.mp3",
"./sounds/hut.mp3",
"./sounds/keys.mp3",
"./sounds/king.mp3",
"./sounds/kite.mp3",
"./sounds/knees.mp3",
"./sounds/knife.mp3",
"./sounds/leaf.mp3",
"./sounds/leg.mp3",
"./sounds/lick.mp3",
"./sounds/light.mp3",
"./sounds/lock.mp3",
"./sounds/log.mp3",
"./sounds/man.mp3",
"./sounds/meat.mp3",
"./sounds/mop.mp3",
"./sounds/mouse.mp3",
"./sounds/mouth.mp3",
"./sounds/mum.mp3",
"./sounds/night.mp3",
"./sounds/nose.mp3",
"./sounds/note.mp3",
"./sounds/nurse.mp3",
"./sounds/nut.mp3",
"./sounds/page.mp3",
"./sounds/pan.mp3",
"./sounds/park.mp3",
"./sounds/peach.mp3",
"./sounds/pen.mp3",
"./sounds/pig.mp3",
"./sounds/purse.mp3",
"./sounds/road.mp3",
"./sounds/rock.mp3",
"./sounds/rose.mp3",
"./sounds/rug.mp3",
"./sounds/sack.mp3",
"./sounds/sad.mp3",
"./sounds/seed.mp3",
"./sounds/shark.mp3",
"./sounds/sheep.mp3",
"./sounds/shell.mp3",
"./sounds/ship.mp3",
"./sounds/shirt.mp3",
"./sounds/shop.mp3",
"./sounds/sock.mp3",
"./sounds/soup.mp3",
"./sounds/suit.mp3",
"./sounds/sword.mp3",
"./sounds/tap.mp3",
"./sounds/tongue.mp3",
"./sounds/van.mp3",
"./sounds/zip.mp3"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        ASSETS_TO_CACHE.map((url) =>
          fetch(url)
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
              return cache.put(url, response);
            })
        )
      ).then((results) => {
        results.forEach((result, i) => {
          if (result.status === "rejected") {
            console.warn(`⚠️ Failed to cache: ${ASSETS_TO_CACHE[i]}`);
          }
        });
      })
    )
  );
});


self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      )
    )
  );
  self.clients.claim(); // Take control of pages
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() =>
          new Response("Offline and not cached", {
            status: 503,
            statusText: "Offline"
          })
        )
      );
    })
  );
});
