const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("app.db");
const cheerio = require("cheerio");
require("dotenv").config();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS steamUsers (
      steamId TEXT PRIMARY KEY,
      steamName TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lastPricesCheck (
      itemId TEXT PRIMARY KEY,
      lastCheck INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS prices (
      itemId TEXT PRIMARY KEY,
      price INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS steamMarketSupplies (
      itemId TEXT PRIMARY KEY,
      marketSupply INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS itemCounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      steamId TEXT,
      itemId TEXT,
      name TEXT,
      amount INTEGER,
      USD REAL,
      USDNoFee REAL,
      lastUpdated INTEGER DEFAULT 0
    )
  `);
});

const app = express();
app.use(express.urlencoded({ extended: true }));

const axios = require("axios");

app.get("/", (req, res) => {
  res.send(`
    <form action="/api/add/steamId" method="post">
      <input type="text" name="steamId" placeholder="Steam ID" />
      <input type="text" name="steamVU" placeholder="Steam Vanity URL" />
      <button type="submit">Submit</button>
    </form>
    <a href="/inventories">Check inventories</a>
    `);
});

app.post("/api/add/steamId", async (req, res) => {
  let steamId = req.body.steamId;
  const steamVU = req.body.steamVU;
  const steamApiKey = process.env.KEY;

  
  if (!steamId && steamVU) {
    try {
      const { data } = await axios.get(
        `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${steamApiKey}&format=json&vanityurl=${steamVU}`
      );
      steamId = data.response.steamid;
    } catch (error) {
      console.error(error);
      res.send("Error resolving Steam Vanity URL");
    }
  }

  if (!steamId) {
    res.send("Steam ID or Vanity URL is required");
  }
  
  try {
    const { data } = await axios.get(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${steamApiKey}&format=json&steamids=${steamId}`
    );
    const steamName = data.response.players[0].personaname;

    const existingUser = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM steamUsers WHERE steamId = ?", [steamId], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (existingUser) {
      res.send(`
        Steam ID already exists
        <div>
          <a href="/inventories">Check inventories</a>
        </div>
        <div>
          <a href="/">Go back</a>
        </div>
      `);
      return;
    }

    db.run("INSERT INTO steamUsers (steamId, steamName) VALUES (?, ?)",
      [steamId, steamName],
      (err) => {
        if (err) {
          res.send(err);
        } else {
          res.send(`
            Steam ID added successfully
            <div>
              <a href="/inventories">Check inventories</a>
            </div>
            <div>
              <a href="/">Go back</a>
            </div>
          `);
        }
    });
  } catch (error) {
    console.error(error);
    res.send(`
      Error adding Steam ID
      <div>
        <a href="/inventories">Check inventories</a>
      </div>
      <div>
        <a href="/">Go back</a>
      </div>
    `);
  }
});

const lastPricesCheck = {};
const prices = {};
const steamMarketSupplies = {};

const items = {
  "5594397966": "Scarecrow Facemask",
  "Scarecrow Facemask": "5594397966",
  "5594397965": "Scarecrow Chestplate",
  "Scarecrow Chestplate": "5594397965",
};

const successfullRequests = {};

app.get("/api/inventory", async (req, res) => {
  const item = req.query.item;
  const prefetch = req.query.prefetch;

  let itemId = item;

  if (isNaN(parseInt(item))) {
    itemId = items[item];
  }

  if (!items[itemId]) {
    itemId = items["Scarecrow Facemask"];
  }

  if (prefetch) {
    return res.json(successfullRequests[itemId] ?? { success: false });
  }

  lastPricesCheck[itemId] = lastPricesCheck[itemId] ?? 0;
  prices[itemId] = prices[itemId] ?? 0;
  steamMarketSupplies[itemId] = steamMarketSupplies[itemId] ?? 0;

  const itemCounts = {};

  try {
    let selectDataFromDb = false;

    if (Date.now() - lastPricesCheck[itemId] > 60000) {
      try {
        const { data: priceData } = await axios.get(`https://steamcommunity.com/market/search?q=${items[itemId]}`, {
          headers: {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "en-US,en;q=0.9",
            "sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Chromium\";v=\"124\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "Referer": "https://steamcommunity.com/market/search",
            "Referrer-Policy": "strict-origin-when-cross-origin"
          }
        });
  
        const $ = cheerio.load(priceData);
    
        prices[itemId] = $(".normal_price[data-price]").attr("data-price") ?? prices[itemId];
    
        steamMarketSupplies[itemId] = $(".market_listing_num_listings_qty[data-qty]").attr("data-qty") ?? steamMarketSupplies[itemId];
  
        lastPricesCheck[itemId] = Date.now();
        db.run("INSERT OR REPLACE INTO lastPricesCheck (itemId, lastCheck) VALUES (?, ?)", [itemId, lastPricesCheck[itemId]]);
  
        if (prices[itemId] !== 0) {
          db.run("INSERT OR REPLACE INTO prices (itemId, price) VALUES (?, ?)", [itemId, prices[itemId]]);
        } else {
          selectDataFromDb = true;
        }
  
        db.run("INSERT OR REPLACE INTO steamMarketSupplies (itemId, marketSupply) VALUES (?, ?)", [itemId, steamMarketSupplies[itemId]]);
      } catch (error) {
        selectDataFromDb = true;
      }

      prices[itemId] = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM prices WHERE itemId = ?", [itemId], (err, row) => {
          if (err) reject(err);

          if (row) {
            resolve(row.price);
          } else {
            resolve(0);
          }
        });
      });

      steamMarketSupplies[itemId] = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM steamMarketSupplies WHERE itemId = ?", [itemId], (err, row) => {
          if (err) reject(err);

          if (row) {
            resolve(row.marketSupply);
          } else {
            resolve(0);
          }
        });
      });
    } else {
      selectDataFromDb = true;
    }

    if (selectDataFromDb) {
      prices[itemId] = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM prices WHERE itemId = ?", [itemId], (err, row) => {
          if (err) reject(err);

          if (row) {
            resolve(row.price);
          } else {
            resolve(0);
          }
        });
      });

      steamMarketSupplies[itemId] = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM steamMarketSupplies WHERE itemId = ?", [itemId], (err, row) => {
          if (err) reject(err);

          if (row) {
            resolve(row.marketSupply);
          } else {
            resolve(0);
          }
        });
      });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM steamUsers", (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    const itemCountsDb = await new Promise((resolve, reject) => {
      db.all("SELECT steamId, lastUpdated FROM itemCounts where itemId = ?", [itemId], (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });

    for (const row of rows) {
      const steamName = row.steamName.replace(/bandit.camp/gi, "").trim();
      if (itemCountsDb.some(itemCount => itemCount.steamId === row.steamId && Date.now() - itemCount.lastUpdated < 60000)) {
        itemCounts[row.steamId] = await new Promise((resolve, reject) => {
          db.get("SELECT * FROM itemCounts WHERE steamId = ? and itemId = ?", [row.steamId, itemId], (err, row) => {
            if (err) reject({
              name: steamName,
              amount: 0,
              USD: 0,
              USDNoFee: 0
            });

            resolve({
              name: row.name,
              amount: row.amount,
              USD: row.USD,
              USDNoFee: row.USDNoFee
            });
          });
        });
        continue;
      }

      let result = null;

      try {
        result = await axios.get(
          `https://steamcommunity.com/inventory/${row.steamId}/252490/2?l=english&count=500`
        );
      } catch {
        
      }

      if (!result || !result.data || result.data.success === false || !result.data.assets) {
        const steamId = row.steamId;
        itemCounts[steamId] = await new Promise((resolve, reject) => {
          db.get("SELECT * FROM itemCounts WHERE steamId = ? and itemId = ?", [steamId, itemId], (err, row) => {
            if (err) reject({
              name: steamName,
              amount: 0,
              USD: 0,
              USDNoFee: 0
            });

            if (row) {
              resolve({
                name: steamName,
                amount: row.amount,
                USD: row.USD,
                USDNoFee: row.USDNoFee
              });
            } else {
              db.run("INSERT INTO itemCounts (steamId, itemId, name, amount, USD, USDNoFee) VALUES (?, ?, ?, ?, ?, ?)",
                [steamId, itemId, steamName, 0, 0, 0]
              );
              resolve({
                name: steamName,
                amount: 0,
                USD: 0,
                USDNoFee: 0
              });
            }
          });
        });
        continue;
      };

      const assets = result.data.assets;

      const amount = assets.filter((item) => item.classid === itemId).length;

      const USDNoFee = Math.round(((prices[itemId] * amount) / 1.15)+1) / 100;
      
      itemCounts[row.steamId] = {
        name: steamName,
        amount: amount,
        USD: (prices[itemId] * amount) / 100,
        USDNoFee: USDNoFee === 0.01 ? 0 : USDNoFee
      };

      const usersItems = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM itemCounts WHERE steamId = ? AND itemId = ?", [row.steamId, itemId], (err, row) => {
          if (err) reject(err);
          resolve(row);
        });
      });

      if (usersItems && itemCounts[row.steamId].amount !== 0) {
        db.run("UPDATE itemCounts SET amount = ?, USD = ?, USDNoFee = ?, lastUpdated = ? WHERE id = ?",
          [itemCounts[row.steamId].amount, itemCounts[row.steamId].USD, itemCounts[row.steamId].USDNoFee, Date.now(), usersItems.id]
        );
      } else if (!usersItems) {
        db.run("INSERT INTO itemCounts (steamId, itemId, name, amount, USD, USDNoFee) VALUES (?, ?, ?, ?, ?, ?)",
          [row.steamId, itemId, steamName, itemCounts[row.steamId].amount, itemCounts[row.steamId].USD, itemCounts[row.steamId].USDNoFee]
        );
      }
    }

    const totalBanditsAmount = Object.values(itemCounts).reduce((acc, curr) => acc + curr.amount, 0);
    const totalBanditsUSD = Math.round(Object.values(itemCounts).reduce((acc, curr) => acc + curr.USD, 0) * 100) / 100;
    const totalBanditsUSDNoFee = Math.round(Object.values(itemCounts).reduce((acc, curr) => acc + curr.USDNoFee, 0) * 100) / 100;

    successfullRequests[itemId] = {
      success: true,
      itemCounts,
      price: prices[itemId] / 100,
      priceNoFee: Math.round((prices[itemId] / 1.15)+1) / 100,
      totalBanditsAmount,
      totalBanditsUSD,
      totalBanditsUSDNoFee,
      steamMarketSupply: steamMarketSupplies[itemId]
    }

    res.json(successfullRequests[itemId]);
  } catch (error) {
    console.error(error);

    require("fs").appendFileSync("error.log", error + "\n");
    res.status(500).json({ error: "Error fetching inventories" });
  }
});

app.get("/inventories", (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Bandit Camp Inventories</title>
    <style>
      body {
        font-family: Arial, sans-serif;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th, td {
        border: 1px solid black;
        padding: 8px;
        text-align: left;
      }
      th {
        background-color: #f2f2f2;
      }
    </style>
    <script>
      let currentItemId = null;

      async function prefetchData(item) {
        const response = await fetch("/api/inventory?item=" + item + "&prefetch=true");

        if (!response.ok) {
          return;
        }

        const data = await response.json();

        if (!data.success) {
          return;
        }
  
        document.getElementById("data").innerHTML = \`
          <p>Total Bandits Items: \${data.totalBanditsAmount}</p>
          <p>Total Bandits USD: $\${data.totalBanditsUSD || "Error fetching price"}</p>
          <p>Total Bandits USD (No Fee): $\${data.totalBanditsUSDNoFee === 0.01 ? "Error fetching price" : data.totalBanditsUSDNoFee}</p>
          <p>Steam Market Supply: \${data.steamMarketSupply}</p>
          <p>Single Item USD: $\${data.price}</p>
          <p>Single Item USD (No Fee): $\${data.priceNoFee}</p>
          <table border="1">
            <thead>
              <tr>
                <th>Steam ID</th>
                <th>Name</th>
                <th>Amount</th>
                <th>USD</th>
                <th>USD (No Fee)</th>
              </tr>
            </thead>
            <tbody>
              \${Object.keys(data.itemCounts)
                .sort((a, b) => data.itemCounts[b].amount - data.itemCounts[a].amount)
                .map(steamId => \`
                <tr>
                  <td><a href="https://steamcommunity.com/profiles/\${steamId}/" target="_blank">\${steamId}</a></td>
                  <td>\${data.itemCounts[steamId].name}</td>
                  <td>\${data.itemCounts[steamId].amount}</td>
                  <td>$\${data.itemCounts[steamId].USD}</td>
                  <td>$\${data.itemCounts[steamId].USDNoFee}</td>
                </tr>
              \`).join("")}
            </tbody>
          </table>
        \`;
      }

      async function fetchData(item) {
        currentItemId = item;
        prefetchData(item);
        try {
          const response = await fetch("/api/inventory?item=" + item);
          
          if (currentItemId !== item) {
            return;
          }
  
          if (!response.ok) {
            alert(response.statusText);
          }
  
          const data = await response.json();
  
          document.getElementById("data").innerHTML = \`
            <p>Total Bandits Items: \${data.totalBanditsAmount}</p>
            <p>Total Bandits USD: $\${data.totalBanditsUSD || "Error fetching price"}</p>
            <p>Total Bandits USD (No Fee): $\${data.totalBanditsUSDNoFee === 0.01 ? "Error fetching price" : data.totalBanditsUSDNoFee}</p>
            <p>Steam Market Supply: \${data.steamMarketSupply}</p>
            <p>Single Item USD: $\${data.price}</p>
            <p>Single Item USD (No Fee): $\${data.priceNoFee}</p>
            <table border="1">
              <thead>
                <tr>
                  <th>Steam ID</th>
                  <th>Name</th>
                  <th>Amount</th>
                  <th>USD</th>
                  <th>USD (No Fee)</th>
                </tr>
              </thead>
              <tbody>
                \${Object.keys(data.itemCounts)
                  .sort((a, b) => data.itemCounts[b].amount - data.itemCounts[a].amount)
                  .map(steamId => \`
                  <tr>
                    <td><a href="https://steamcommunity.com/profiles/\${steamId}/" target="_blank">\${steamId}</a></td>
                    <td>\${data.itemCounts[steamId].name}</td>
                    <td>\${data.itemCounts[steamId].amount}</td>
                    <td>$\${data.itemCounts[steamId].USD}</td>
                    <td>$\${data.itemCounts[steamId].USDNoFee}</td>
                  </tr>
                \`).join("")}
              </tbody>
            </table>
          \`;
        } catch {
          // Handle error
        }
      }
    </script>
  </head>
  <body>
    <div>
      ${Object.keys(items).filter(item => !isNaN(parseInt(item))).map((item) => `<button onclick="fetchData('${item}')">${items[item]}</button>`).join("")}
    </div>
    <div id="data"></div>
  </body>
`)
});

app.listen(6976, () => {
  console.log("Server is running on port 6976");
  start();
});

const start = async () => {
  await new Promise((resolve, reject) => {
    db.all("SELECT * FROM lastPricesCheck", (err, rows) => {
      if (err) reject(err);

      resolve(rows.forEach(row => {
        lastPricesCheck[row.itemId] = row.lastCheck;
      }));
    });
  });

  await new Promise((resolve, reject) => {
    db.all("SELECT * FROM prices", (err, rows) => {
      if (err) reject(err);

      resolve(rows.forEach(row => {
        prices[row.itemId] = row.price;
      }));
    });
  });

  await new Promise((resolve, reject) => {
    db.all("SELECT * FROM steamMarketSupplies", (err, rows) => {
      if (err) reject(err);

      resolve(rows.forEach(row => {
        steamMarketSupplies[row.itemId] = row.marketSupply;
      }));
    });
  });

  const itemCountsRows = await new Promise((resolve, reject) => {
    db.all("SELECT * FROM itemCounts", (err, rows) => {
      if (err) reject(err);
      resolve(rows);
    });
  });
  
  Object.keys(lastPricesCheck).forEach(async (itemId) => {
    successfullRequests[itemId] = {
      success: true,
      itemCounts: itemCountsRows.reduce((acc, row) => {
        if (row.itemId === itemId) {
          acc[row.steamId] = {
            name: row.name,
            amount: row.amount,
            USD: row.USD,
            USDNoFee: row.USDNoFee
          };
        }
        return acc;
      }, {}),
      price: prices[itemId] / 100,
      priceNoFee: Math.round((prices[itemId] / 1.15)+1) / 100,
      totalBanditsAmount: itemCountsRows.filter(row => row.itemId === itemId).reduce((acc, row) => acc + row.amount, 0),
      totalBanditsUSD: Math.round(itemCountsRows.filter(row => row.itemId === itemId).reduce((acc, row) => acc + row.USD, 0) * 100) / 100,
      totalBanditsUSDNoFee: Math.round(itemCountsRows.filter(row => row.itemId === itemId).reduce((acc, row) => acc + row.USDNoFee, 0) * 100) / 100,
      steamMarketSupply: steamMarketSupplies[itemId]
    };
  })
};