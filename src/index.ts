import axios from "axios";
import "colors";
import { randomInt } from "node:crypto";
import { input, select } from "@inquirer/prompts";
import Database from "better-sqlite3";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import env from "./env";

const BASE_URL = "https://europe-west1-mesocricetus-raddei.cloudfunctions.net/";

const db = new Database("accounts.db");

const ensureTableExists = () => {
	const tableExists = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='accounts';",
		)
		.get();

	if (!tableExists) {
		db.prepare(`
            CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phoneNumber TEXT,
                session TEXT,
                proxy TEXT
            );
        `).run();
	}
};

const _headers = {
	accept: "application/json, text/plain, */*",
	"accept-encoding": "gzip, deflate, br, zstd",
	"accept-language": "ru,ru-RU;q=0.9,en-US;q=0.8,en;q=0.7",
	origin: "https://tg-app-embed.electra.trade",
	priority: "u=1, i",
	referer: "https://tg-app-embed.electra.trade/",
	"sec-ch-ua":
		'"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
	"sec-ch-ua-mobile": "?1",
	"sec-ch-ua-platform": '"Android"',
	"sec-fetch-dest": "empty",
	"sec-fetch-mode": "cors",
	"sec-fetch-site": "cross-site",
	"user-agent":
		"Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.86 Mobile Safari/537.36 Telegram-Android/11.2.2 (Xiaomi 22071219CG; Android 14; SDK 34; HIGH)",
	"x-requested-with": "org.telegram.messenger",
};

const createSession = async (phoneNumber: string, proxy: string) => {
	try {
		const client = new TelegramClient(
			new StringSession(""),
			env.APP_ID,
			env.API_HASH,
			{
				deviceModel: env.DEVICE_MODEL,
				connectionRetries: 5,
			},
		);

		await client.start({
			phoneNumber: async () => phoneNumber,
			password: async () => await input({ message: "Enter your password:" }),
			phoneCode: async () =>
				await input({ message: "Enter the code you received:" }),
			onError: (err: Error) => {
				if (
					!err.message.includes("TIMEOUT") &&
					!err.message.includes("CastError")
				) {
					console.log(`Telegram authentication error: ${err.message}`.red);
				}
			},
		});

		console.log("Successfully created a new session!".green);
		const stringSession = client.session.save() as unknown as string;

		db.prepare(
			"INSERT INTO accounts (phoneNumber, session, proxy) VALUES (@phoneNumber, @session, @proxy)",
		).run({ phoneNumber, session: stringSession, proxy });

		await client.sendMessage("me", {
			message: "Successfully created a new session!",
		});
		console.log("Saved the new session to session file.".green);
		await client.disconnect();
		await client.destroy();
	} catch (e) {
		const error = e as Error;
		if (
			!error.message.includes("TIMEOUT") &&
			!error.message.includes("CastError")
		) {
			console.log(`Error: ${error.message}`.red);
		}
	}
};

const showAllAccounts = async () => {
	const stmt = db.prepare("SELECT id, phoneNumber, proxy FROM accounts");
	const arr = [];
	for (const row of stmt.iterate()) {
		arr.push(row);
		console.log(row);
	}
	return arr;
};

const deleteAccount = async (id: number) => {
	await db.prepare("DELETE FROM accounts WHERE id=(@id)").run({ id });
	console.log(`Account ${id} is delete`);
};

const getQueryId = async (phoneNumber: string, session: string) => {
	const client = new TelegramClient(
		new StringSession(session),
		env.APP_ID,
		env.API_HASH,
		{
			deviceModel: env.DEVICE_MODEL,
			connectionRetries: 5,
		},
	);

	await client.start({
		phoneNumber: async () => phoneNumber,
		password: async () => await input({ message: "Enter your password:" }),
		phoneCode: async () =>
			await input({ message: "Enter the code you received:" }),
		onError: (err: Error) => {
			if (
				!err.message.includes("TIMEOUT") &&
				!err.message.includes("CastError")
			) {
				console.log(`Telegram authentication error: ${err.message}`.red);
			}
		},
	});

	try {
		const peer = await client.getInputEntity("ElectraAppBot");
		if (!peer) {
			console.log("Failed to get peer entity.".red);
			return;
		}

		let response = await client.getMessages(peer, {
			limit: 10,
		});

		let openButton = await (async () => {
			if (!response || response.length === 0) {
				return;
			}

			for (const msg of response) {
				if (!msg.buttons) continue;

				for (const row of msg.buttons) {
					for (const button of row) {
						if (button.text?.includes("Launch Electra")) {
							return button.button;
						}
					}
				}
			}
		})();

		if (!openButton) {
			const startMessage = await client.sendMessage(peer, {
				message: "/start",
			});

			await new Promise((res) => setTimeout(res, 10 * 1e3));

			if (!startMessage) {
				throw new Error("Failed to send command to the bot.");
			}

			response = await client.getMessages(peer, {
				limit: 10,
			});

			if (!response || response.length === 0) {
				throw new Error("No response received from bot after /start command.");
			}

			openButton = await (async () => {
				for (const msg of response) {
					if (!msg.buttons) continue;

					for (const row of msg.buttons) {
						for (const button of row) {
							if (button.text?.includes("Launch Electra")) {
								return button.button;
							}
						}
					}
				}
			})();
		}

		if (!openButton) {
			throw new Error("Failed to find 'Launch Electra' button.");
		}

		const webview = await client.invoke(
			new Api.messages.RequestWebView({
				peer,
				bot: peer,
				fromBotMenu: false,
				platform: "android",
				// @ts-ignore
				url: openButton.url,
			}),
		);

		if (!webview || !webview.url) {
			console.log("Failed to get webview URL.".red);
			return;
		}
		const query = decodeURIComponent(
			webview.url.split("&tgWebAppVersion=")[0].split("#tgWebAppData=")[1],
		);

		return query;
	} catch (e) {
		console.log(`Error retrieving query data: ${(e as Error).message}`.red);
	} finally {
		await client.disconnect();
		await client.destroy();
	}
};

const extractUserData = (queryId: string) => {
	const urlParams = new URLSearchParams(queryId);
	const user = JSON.parse(decodeURIComponent(urlParams.get("user") ?? ""));
	return {
		user: urlParams.get("user"),
		userParsed: user,
		extUserId: user.id,
		extUserName: user.username,
	};
};

const getSetting = async ({
	prefix,
	proxy,
	query,
}: {
	prefix: string;
	proxy: string;
	query: string;
}) => {
	const url = `${BASE_URL}/api/settings`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const res = await axios.get(
		url,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "Settings:", res.data);

	return res.data;
};

const getUserData = async ({
	prefix,
	proxy,
	query,
}: {
	prefix: string;
	proxy: string;
	query: string;
}) => {
	const url = `${BASE_URL}/api/userData`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const res = await axios.get(
		url,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "userData", res.data);

	return res.data.user;
};

const postUserByReferralId = async ({
	prefix,
	proxy,
	query,
}: {
	prefix: string;
	proxy: string;
	query: string;
}) => {
	const url = `${BASE_URL}/api/userByReferralId`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const res = await axios.post(
		url,
		{
			referralId: "",
		},
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "userByReferralId", res.data);

	return res.data;
};

const postUserData = async ({
	prefix,
	proxy,
	query,
}: {
	prefix: string;
	proxy: string;
	query: string;
}) => {
	const url = `${BASE_URL}/api/addUser`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const { userParsed } = extractUserData(query);

	const res = await axios.post(
		url,
		{
			userData: {
				user_id: `${userParsed.id}`,
				username:
					`${userParsed.username}` ||
					`${userParsed.first_name} ${userParsed.last_name}`,
				first_name: userParsed.first_name,
				last_name: userParsed.last_name,
				points: 0,
				avatar: "avatar2",
				rank: 1,
				last_active: +new Date(),
				last_time_played: 0,
				referal_id: "",
				referred_by: "",
				referal_count: 0,
				referral_points_breakdown: {},
				points_earned_from_friends: 0,
				farming_rate: 1,
				farming_started: 0,
				upgrade_level: 1,
				teams: [],
				daily_streak: [{ claimed: false, claimed_date: +new Date() }],
				friend_list: [""],
				team_ranks: {},
				language: "ru",
			},
			refUserId: "",
		},
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "new suserData", res.data);

	return res.data;
};

const getUpdateUserLastActive = async ({
	prefix,
	proxy,
	query,
}: {
	prefix: string;
	proxy: string;
	query: string;
}) => {
	const url = `${BASE_URL}/api/updateUserLastActive`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const res = await axios.get(
		url,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "updateUserLastActive", res.data);

	return res.data;
};

const postUpdateStreak = async ({
	prefix,
	proxy,
	query,
	payload,
}: {
	prefix: string;
	proxy: string;
	query: string;
	payload: {
		daily_streak: { claimed_date: number; claimed: true }[];
		userStreak: number;
		reward: number;
	};
}) => {
	const url = `${BASE_URL}/api/updateStreak`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const res = await axios.post(
		url,
		payload,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "updateStreak", res.data);

	return res.data;
};

const getBtcPrice = async ({
	prefix,
	proxy,
	query,
}: {
	prefix: string;
	proxy: string;
	query: string;
}): Promise<{ mins: number; price: string; closeTime: number }> => {
	const url = `${BASE_URL}/api/btcPrice`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const res = await axios.get(
		url,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "btcPrice", res.data);

	return res.data;
};

const postStartFarming = async ({
	prefix,
	proxy,
	query,
	settingsData,
	userData,
}: {
	prefix: string;
	proxy: string;
	query: string;
	userData: {
		guess: {
			type: "down" | "up";
			btcPrice: number;
			duration: number;
			pointsToWin: number;
			timeOfGuess: number;
		};
		guessWinStreak?: number;
		farming_rate: number;
	};
	settingsData: {
		MAX_BTC_WIN_STREAK: number;
		FARM_HOURS: number;
	};
}) => {
	const duration = settingsData.FARM_HOURS;
	const pointsToWin = 600 * (userData.guessWinStreak || 1);

	const url = `${BASE_URL}/api/startFarming`;
	const headers = { ..._headers, "x-telegram-init-data": query };

	const { price } = await getBtcPrice({ prefix, proxy, query });

	const type = Math.random() < 0.5 ? "down" : "up";
	console.log(prefix, "Guess type:", type);
	const btcPrice = Number.parseFloat(price || "0");
	const timeOfGuess = +Date.now();

	const payload = {
		guess: {
			type,
			btcPrice,
			duration,
			timeOfGuess,
			pointsToWin,
		},
	};

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "postStartFarming payload", payload);

	const res = await axios.post(
		url,
		payload,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "startFarming", res.data);

	return res.data;
};

const postResetFarming = async ({
	prefix,
	proxy,
	query,
	userData,
	settingsData,
}: {
	prefix: string;
	proxy: string;
	query: string;
	userData: {
		guess: {
			type: "down" | "up";
			btcPrice: number;
			duration: number;
			pointsToWin: number;
			timeOfGuess: number;
		};
		guessWinStreak?: number;
		farming_rate: number;
	};
	settingsData: {
		MAX_BTC_WIN_STREAK: number;
		FARM_HOURS: number;
	};
}) => {
	const headers = { ..._headers, "x-telegram-init-data": query };

	const guessBtcPrice = await axios.get(`${BASE_URL}/api/guessBtcPrice`, {
		headers,
	});

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "guessBtcPrice", guessBtcPrice.data);

	const btcPrices = guessBtcPrice.data;
	const priceBefore = Number.parseFloat(btcPrices.priceBefore);
	const priceAfter = Number.parseFloat(btcPrices.priceAfter);

	await new Promise((resolve) => setTimeout(resolve, randomInt(1e3, 5e3)));

	const guessType = userData.guess.type;
	const isWin =
		(guessType === "down" && priceBefore > priceAfter) ||
		(guessType === "up" && priceBefore < priceAfter);

	console.log(prefix, isWin ? "You won!".green : "You lost!".red);

	let winStreak = isWin ? (userData.guessWinStreak || 0) + 1 : 0;
	if (winStreak > settingsData.MAX_BTC_WIN_STREAK) {
		winStreak = settingsData.MAX_BTC_WIN_STREAK;
	}

	console.log(prefix, "Your winStreak:", winStreak);

	const pointsToWin = userData.farming_rate * 600 * (winStreak + 1);

	const payload = { pointsToWin: pointsToWin, winStreak: winStreak };

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "resetFarming payload:", payload);

	const res = await axios.post(
		`${BASE_URL}/api/resetFarming`,
		payload,
		proxy ? { headers, httpsAgent: new HttpsProxyAgent(proxy) } : { headers },
	);

	if (process.env.NODE_ENV === "development")
		console.log(prefix, "resetFarming", res.data);

	await new Promise((resolve) => setTimeout(resolve, randomInt(1e3, 5e3)));

	await postStartFarming({ prefix, proxy, query, settingsData, userData });
};

const farm = async (account: {
	phoneNumber: string;
	session: string;
	proxy: string;
}) => {
	while (true) {
		try {
			const { phoneNumber, session, proxy } = account;
			const query = await getQueryId(phoneNumber, session);

			if (!query) {
				console.log(`Failed to get query data for ${phoneNumber}`.red);
				return;
			}

			const { extUserId } = extractUserData(query);
			const prefix = `[${extUserId}]`.blue;

			console.log(prefix, "Start farming...");

			const settingsData = await getSetting({ prefix, proxy, query });

			let userData = null;
			try {
				userData = await getUserData({ prefix, proxy, query });
			} catch (e) {
				// await postUserByReferralId({ prefix, proxy, query });
				// userData = await postUserData({ prefix, proxy, query });

				console.log(prefix, "Error:", (e as Error).message);
				throw e;
			}

			if (!userData) {
				console.log(prefix, "Failed to get user data.".red);
				return;
			}

			userData = await getUpdateUserLastActive({ prefix, proxy, query });

			const dailyStreak = userData.daily_streak || [];
			if (!dailyStreak.length) {
				console.log(prefix, "No daily streak data found.".red);
				return;
			}

			const lastStreak = dailyStreak[dailyStreak.length - 1];

			if (lastStreak && !lastStreak.claimed) {
				console.log(prefix, "Claiming daily reward...");
				const rewardList = settingsData.DAILY_REWARD_LIST || [];

				const userStreak = dailyStreak.length;
				const reward =
					rewardList[userStreak - 1] || rewardList[rewardList.length - 1];

				const streakData = {
					daily_streak: dailyStreak.map(
						(el: { claimed_date: number; claimed: boolean }) => ({
							...el,
							claimed: true,
						}),
					),
					userStreak: userStreak,
					reward: reward,
				};

				await new Promise((resolve) =>
					setTimeout(resolve, randomInt(1e3, 5e3)),
				);

				await postUpdateStreak({ prefix, proxy, query, payload: streakData });
			} else {
				console.log(
					prefix,
					"Daily reward already claimed. Waiting for next round...",
				);
			}

			await getBtcPrice({ prefix, proxy, query });

			if (userData.farming_started) {
				const farmingData = userData.guess;
				const timeOfGuess = farmingData.timeOfGuess;
				const currentTime = Date.now();
				const elapsedTime = currentTime - timeOfGuess;

				if (elapsedTime >= settingsData.FARM_HOURS * 60 * 60 * 1000) {
					console.log(prefix, "Farming...");

					await postResetFarming({
						prefix,
						proxy,
						query,
						userData,
						settingsData,
					});
				} else {
					console.log(prefix, "Waiting for next farming round...");
				}
			} else {
				await postStartFarming({
					prefix,
					proxy,
					query,
					settingsData,
					userData,
				});
			}

			const sleep =
				settingsData.FARM_HOURS * 60 * 60 * 1000 +
				randomInt(1 * 60 * 1e3, 20 * 60 * 1e3);

			console.log(
				prefix,
				`Sleeping for ${Math.round(sleep / 1000 / 60)} minutes...`,
			);

			await new Promise((resolve) => setTimeout(resolve, sleep));
		} catch (e) {
			console.log(`Error: ${(e as Error).message}`.red);
			await new Promise((resolve) =>
				setTimeout(resolve, randomInt(1 * 60 * 1e3, 20 * 60 * 1e3)),
			);
		}
	}
};

const start = async () => {
	const stmt = db.prepare("SELECT phoneNumber, session, proxy FROM accounts");
	const accounts = [...stmt.iterate()] as {
		phoneNumber: string;
		session: string;
		proxy: string;
	}[];

	await Promise.all(accounts.map(farm));
};

(async () => {
	ensureTableExists();

	while (true) {
		const mode = await select({
			message: "Please choose an option:",
			choices: [
				{
					name: "Start farming",
					value: "start",
					description: "Start playing game",
				},
				{
					name: "Add account",
					value: "add",
					description: "Add new account to DB",
				},
				{
					name: "Show all accounts",
					value: "show",
					description: "show all added accounts",
				},
				{
					name: "Delete account",
					value: "delete",
					description: "delete account",
				},
			],
		});

		switch (mode) {
			case "add": {
				const phoneNumber = await input({
					message: "Enter your phone number (+):",
				});

				const proxy = await input({
					message:
						"Enter proxy (in format http://username:password@host:port):",
				});

				await createSession(phoneNumber, proxy);
				break;
			}
			case "show": {
				showAllAccounts();
				break;
			}
			case "start": {
				await start();
				break;
			}
			case "delete": {
				const allAccounts = await showAllAccounts();
				const choicesArr = allAccounts.map((el) => {
					//@ts-ignore
					const { id } = el;
					return { name: `id: ${id}`, value: id };
				});

				const accountId = await select({
					message: "Select an account to delete:",
					choices: choicesArr,
				});

				await deleteAccount(accountId);
				break;
			}
			default:
				break;
		}
	}
})();
