"use strict";

exports.init = function (y, config, messages, cron, logger) {
	messages.add('kiosk_monthly_archive', "Hey [name], I have archived all your Kiosk bookings for [month]. This is the automatic monthly archive. \nYour current account balance is CHF [balance]");
	messages.add('kiosk_initialize', "Hey [name], I have initialized your digital kiosk account. Your current account balance is CHF [balance]");
	messages.add('kiosk_tally', "Hey [name], [recs] have been carried over from the tally list to your digital kiosk account. \nYour new account balance is CHF [balance]");
	messages.add('kiosk_deposit', "Hey [name], you have successfully deposited CHF [deposit] to your digital kiosk account. \nYour new account balance is CHF [balance]");
	messages.add('kiosk_withdraw', "Hey [name], you have successfully withdrawn CHF [withdrawal] from your digital kiosk account. \nYour new account balance is CHF [balance]");
	messages.add('kiosk_receivemoney', "Hey [name], [senderName] has sent you CHF [amount] because \"[remark]\". \nYour new account balance is CHF [balance]");

	require('datejs');

	var path = require('path'),
		fs = require('fs'),
		express = require('express'),
		ejs = require('ejs'),
		sanitize = require('validator').sanitize,
		fancyTimestamp = require('fancy-timestamp'),
		items = require('./items'),
		Item = items.Item,
		accounts = require('./accounts'),
		Account = accounts.Account,
		bookings = require('./bookings'),
		Booking = bookings.Booking,
		stocks = require('./stocks'),
		Stock = stocks.Stock,
		kioskLogger = require('./logger'),
		formatMoney,
		pluginDir,
		publicDir,
		viewsDir,
		dataDir,
		app,
		authCheck,
		purchaseItem,
		tallyCarryOver,
		archiveAll,
		archiveUserAccount,
		allBookings,
		archiverCron;

	formatMoney = function (n) {
		var c = 2, d = '.', t = "'", s, i, j;

		c = isNaN(c = Math.abs(c)) ? 2 : c;
		d = d === undefined ? "," : d;
		t = t === undefined ? "." : t;
		s = n < 0 ? "-" : "";
		i = String(parseInt(n = Math.abs(+n || 0).toFixed(c), 10));
		j = (j = i.length) > 3 ? j % 3 : 0;

		return s + (j ? i.substr(0, j) + t : "") + i.substr(j).replace(/(\d{3})(?=\d)/g, "$1" + t) + (c ? d + Math.abs(n - i).toFixed(c).slice(2) : "");
	};

	ejs.filters.isodate = function (time) {
		return new Date(time).toString("yyyy-MM-dd HH:mm:ss");
	};

	ejs.filters.isodate_short = function (time) {
		return new Date(time).toString("MM-dd HH:mm");
	};

	ejs.filters.fancy_timestamp = function (time) {
		return fancyTimestamp(time, true);
	};

	ejs.filters.round = function (num) {
		var dec = 2;
		return Math.round(num * Math.pow(10, dec)) / Math.pow(10, dec);
	};



	ejs.filters.money = function (n) {
		return formatMoney(n);
	};

	pluginDir = __dirname;
	publicDir = path.join(pluginDir, 'public');
	viewsDir = path.join(pluginDir, 'views');
	dataDir = path.join(pluginDir, 'data');

	if (!path.existsSync(pluginDir)) { fs.mkdirSync(pluginDir, '0777'); }
	if (!path.existsSync(publicDir)) { fs.mkdirSync(publicDir, '0777'); }
	if (!path.existsSync(viewsDir)) { fs.mkdirSync(viewsDir, '0777'); }
	if (!path.existsSync(dataDir)) { fs.mkdirSync(dataDir, '0777'); }

	items.dataDir = dataDir;
	items.load();
	accounts.dataDir = dataDir;
	kioskLogger.dataDir = dataDir;
	stocks.dataDir = dataDir;

	y.on('usersloaded', function () {
		kioskLogger.init(y.users());
	});

	authCheck = function (req, res, callback) {
		var b64URL, userId;

		if (typeof req.cookies === 'undefined') { req.cookies = {}; }
		b64URL = new Buffer(req.url).toString('base64');
		userId = req.cookies.irmakioskid;
		if (!userId || !y.user(userId)) { res.redirect('/login/' + b64URL); return; }

		req.userId = userId;
		callback();
	};

	purchaseItem = function (userId, itemId, callback) {
		var account, item, booking;

		account = accounts.get(userId);
		item = items.get(itemId);

		if (!account || !item) { callback(true); return; }

		booking = new Booking({
			'id' : bookings.uuid(),
			'itemId' : itemId,
			'time' : Date.now(),
			'amount' : item.price() * -1,
			'name' : item.name(),
			'description' : item.description(),
			'type' : 'purchase'
		});

		account.book(booking, function () {
			var stock;

			callback(false, booking.id());

			if (item.isStockable()) {
				stock = stocks.get(item.id());
				stock.update({
					'bookingId' : booking.id(),
					'type' : 'consumption',
					'change' : item.ration() * -1
				});
			}
		});
	};

	tallyCarryOver = function (userId, rec, callback) {
		var account, booking;

		account = accounts.get(userId);

		booking = new Booking({
			'id' : bookings.uuid(),
			'itemId' : null,
			'time' : Date.now(),
			'amount' : rec.total * -1,
			'name' : rec.marks + ' x ' + rec.item.name(),
			'description' : 'Tally list carry over',
			'type' : 'tally carry over',
			'admin' : true
		});

		account.book(booking, function () {
			callback(false, booking.id(), rec);
		});
	};

	app = express.createServer(
//		express.logger(),
		express.static(publicDir),
		express.bodyParser(),
		express.cookieParser()
	);

	app.configure(function () {
		app.set('views', viewsDir);
	});

	app.listen(config.kiosk.port, function () {
		console.log('Kiosk running on port ' + config.kiosk.port);
	});

	app.get('/', function (req, res) {
		authCheck(req, res, function () {
			var userId = req.userId,
				itemList, stockInfo, stock;

			itemList = items.all();
			stockInfo = {};

			for (var itemId in itemList) {
				if (itemList.hasOwnProperty(itemId)) {
					if (itemList[itemId].isStockable()) {
						stock = stocks.get(itemId);
						stockInfo[itemId] = stock.info();
					}
				}
			}

			res.render('index.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'items' : items.all(),
				'stockInfo' : stockInfo
			});
		});

	});

	app.get('/manifest.webapp', function (req, res) {
		res.setHeader('Content-Type', 'application/x-web-app-manifest+json');
		var manifest = {
			"name": "I.R.M.A. Kiosk",
			"description": "Pausenkiosk",
			"launch_path": "/",
			"icons": {
				"114": "/img/apple-touch-icon-114x114-precomposed.png",
				"128": "/img/apple-touch-icon-114x114-precomposed.png"
			},
			"developer": {
				"name": "Max Kueng",
				"url": "http://maxkueng.com/"
			},
			"default_locale": "en"
		};
		res.send(manifest);
	});

	app.get('/about', function (req, res) {
		res.render('about.ejs', {
			'layout' : 'layout.ejs',
			'req' : req,
			'res' : res
		});

	});

	app.get('/login/:b64url?', function (req, res) {
		res.render('login.ejs', {
			'layout' : 'layout.ejs',
			'req' : req,
			'res' : res,
			'users' : y.users(),
			'redirecturl' : req.params.b64url || '/'
		});
	});

	app.get('/auth/:id/:b64url?', function (req, res) {
		var userId, user, b64url, url;

		userId = req.params.id;
		user = y.user(userId);
		if (user) {
			res.cookie('irmakioskid', user.id(), { 'path' : '/', 'expires' : new Date(Date.now() + (360 * 24 * 3600 * 1000)), 'httpOnly' : true });
		}

		b64url = req.params.b64url;
		url = '/';
		if (b64url) { url = new Buffer(b64url, 'base64').toString('utf8'); }

		res.redirect(url);
	});

	app.get('/logout', function (req, res) {
		res.clearCookie('irmakioskid', { 'path' : '/' });
		res.redirect('/');
	});

	app.get('/pay/:itemId', function (req, res) {
		authCheck(req, res, function () {
			var userId, account;

			userId = req.userId;
			account = accounts.get(userId);

			purchaseItem(userId, req.params.itemId, function (err, bookingId) {
				if (err) { res.redirect('/error'); return; }

				res.redirect('/paid/' + bookingId);
				kioskLogger.log(userId, account, account.booking(bookingId));
			});
		});
	});

	app.get('/reverse/:bookingId', function (req, res) {
		authCheck(req, res, function () {
			var userId, account, oldBooking;

			userId = req.userId;
			account = accounts.get(userId);
			oldBooking = account.booking(req.params.bookingId);

			account.reverse(oldBooking.id(), function (err, bookingId) {
				var booking, item, stock, stockUpdate;

				if (err) { res.redirect('/error'); return; }
				booking = account.booking(bookingId);

				if (oldBooking.itemId()) {
					item = items.get(oldBooking.itemId());

					if (item.isStockable()) {
						stock = stocks.get(item.id());
						stockUpdate = stock.updateByBookingId(req.params.bookingId);

						stock.update({
							'bookingId' : booking.id(),
							'type' : 'reverse',
							'change' : stockUpdate.change * -1
						});
					}
				}

				res.redirect('/account');
				kioskLogger.log(userId, account, account.booking(bookingId));
			});
		});
	});

	app.get('/admin', function (req, res) {
		authCheck(req, res, function () {
			var userId = req.userId;
			res.redirect('/deposit');
		});
	});

	app.get('/deposit', function (req, res) {
		authCheck(req, res, function () {
			var userId = req.userId;

			res.render('deposit.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'users' : y.users()
			});
		});

	});

	app.post('/deposit', function (req, res) {
		authCheck(req, res, function () {
			var userId, user, amount, account;

			userId = req.userId;
			user = parseInt(req.body.user, 10);
			amount = parseInt(req.body.amount * 100, 10);
			account = accounts.get(user);
			
			var cashAccount = accounts.get(config.kiosk.cashUser);
			
			cashAccount.withdraw(amount, function (err, bookingId) {
				kioskLogger.log(userId, cashAccount, cashAccount.booking(bookingId));
			});

			account.deposit(amount, function (err, bookingId) {
				var text, booking;

				res.render('depositok.ejs', {
					'layout' : 'layout.ejs',
					'req' : req,
					'res' : res,
					'balance' : account.balance(),
					'booking' : account.booking(bookingId)
				});

				kioskLogger.log(userId, account, account.booking(bookingId));

				text = messages.get('kiosk_deposit', {
					'name' : y.user(user).fullName(),
					'deposit' : formatMoney(amount / 100),
					'balance' : formatMoney(account.balance() / 100)
				});

				y.sendMessage(function (error, msg) {
					var thread = y.thread(msg.threadId());
					thread.setProperty('type', 'kiosk_deposit');
					thread.setProperty('status', 'closed');
					y.persistThread(thread);

				}, text, { 'direct_to' : user });
			});
		});
	});

	app.get('/withdraw', function (req, res) {
		authCheck(req, res, function () {
			var userId = req.userId;

			res.render('withdraw.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'users' : y.users()
			});
		});
	});

	app.post('/withdraw', function (req, res) {
		authCheck(req, res, function () {
			var userId, user, amount, account;

			userId = req.userId;
			user = parseInt(req.body.user, 10);
			amount = parseInt(req.body.amount * 100, 10);
			account = accounts.get(user);
			
			var cashAccount = accounts.get(config.kiosk.cashUser);
			
			cashAccount.deposit(amount, function (err, bookingId) {
				kioskLogger.log(userId, cashAccount, cashAccount.booking(bookingId));
			});

			account.withdraw(amount, function (err, bookingId) {
				var text;

				res.render('withdrawok.ejs', {
					'layout' : 'layout.ejs',
					'req' : req,
					'res' : res,
					'balance' : account.balance(),
					'booking' : account.booking(bookingId)
				});

				kioskLogger.log(userId, account, account.booking(bookingId));

				text = messages.get('kiosk_withdraw', {
					'name' : y.user(user).fullName(),
					'withdrawal' : formatMoney(amount / 100),
					'balance' : formatMoney(account.balance() / 100)
				});

				y.sendMessage(function (error, msg) {
					var thread = y.thread(msg.threadId());
					thread.setProperty('type', 'kiosk_withdrawal');
					thread.setProperty('status', 'closed');
					y.persistThread(thread);

				}, text, { 'direct_to' : user });
			});
		});
	});

	app.get('/stock', function (req, res) {
		authCheck(req, res, function () {
			var userId, allItems, stockableItems, item;

			userId = req.userId;
			allItems = items.all();
			stockableItems = [];

			for (var itemId in allItems) {
				if (allItems.hasOwnProperty(itemId)) {
					item = items.get(itemId);
					if (item.isStockable()) { stockableItems.push(item); }
				}
			}

			res.render('stock.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'stockableItems' : stockableItems
			});
		});

	});

	app.post('/stock', function (req, res) {
		authCheck(req, res, function () {
			var userId, amount, description, itemId,
				stockChange, restockMode, account,
				item, bookingName, booking;

			userId = req.userId;
			amount = parseInt(req.body.amount * 100, 10);
			description = req.body.description;
			itemId = req.body.item;
			stockChange = parseInt(req.body.stock, 10);
			restockMode = req.body.restockmode;
			account = accounts.get(userId);
			item = null;
			if (restockMode === 'item') { item = items.get(itemId); }

			bookingName = 'Stock';
			if (item && item.isStockable()) { bookingName += ': ' + item.name(); }
			if (!item && description) { bookingName += ': ' + description; }

			booking = new Booking({
				'id' : bookings.uuid(),
				'itemId' : ( (restockMode === 'item') ? itemId : null ),
				'time' : Date.now(),
				'amount' : amount,
				'name' : bookingName,
				'description' : (item && item.isStockable()) ? item.name() + ': ' + stockChange + ' ' + item.unit() : description,
				'type' : 'stock'
			});

			account.book(booking, function (err, bookingId) {
				res.redirect('/account');

				if (restockMode === 'item') {
					if (item && item.isStockable()) {
						var stock = stocks.get(item.id());
						stock.update({
							'bookingId' : bookingId,
							'type' : 'restock',
							'change' : stockChange
						});
					}
				}

				kioskLogger.log(userId, account, account.booking(bookingId));
			});

		});
	});

	app.get('/sendmoney', function (req, res) {
		authCheck(req, res, function () {
			res.render('sendmoney.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'users' : y.users()
			});
		});
	});

	app.post('/sendmoney', function (req, res) {
		authCheck(req, res, function () {
			var userId, recipientId, amount, remark,
				user, recipient,
				sourceAccount, sourceBooking, sourceBookingId,
				targetAccount, targetBooking, targetBookingId,
				text;

			userId = req.userId;
			recipientId = parseInt(req.body.recipient, 10);
			amount = parseInt(req.body.amount * 100, 10);
			remark = req.body.remark;
			user = y.user(userId);
			recipient = y.user(recipientId);

			sourceAccount = accounts.get(userId);
			targetAccount = accounts.get(recipientId);

			sourceBookingId = bookings.uuid();
			targetBookingId = bookings.uuid();

			sourceBooking = new Booking({
				'id' : sourceBookingId,
				'itemId' : null,
				'time' : Date.now(),
				'amount' : amount * -1,
				'name' : 'CHF ' + formatMoney(amount / 100) + ' to ' + recipient.fullName(),
				'description' : remark,
				'relatedBookingId' : targetBookingId,
				'type' : 'send money',
				'sender' : userId,
				'recipient' : recipientId
			});

			targetBooking = new Booking({
				'id' : targetBookingId,
				'itemId' : null,
				'time' : Date.now(),
				'amount' : amount,
				'name' : 'CHF ' + formatMoney(amount / 100) + ' from ' + user.fullName(),
				'description' : remark,
				'relatedBookingId' : sourceBookingId,
				'type' : 'send money',
				'sender' : userId,
				'recipient' : recipientId
			});

			sourceAccount.book(sourceBooking, function (err, bookingId) {
				res.redirect('/transaction/' + bookingId);

				kioskLogger.log(userId, sourceAccount, sourceAccount.booking(bookingId));
			});

			targetAccount.book(targetBooking, function (err, bookingId) {
				kioskLogger.log(userId, targetAccount, targetAccount.booking(bookingId));

				text = messages.get('kiosk_receivemoney', {
					'name' : recipient.fullName(),
					'senderName' : user.fullName(),
					'amount' : formatMoney(amount / 100),
					'remark' : remark,
					'balance' : formatMoney(targetAccount.balance() / 100)
				});

				y.sendMessage(function (error, msg) {
					var thread = y.thread(msg.threadId());
					thread.setProperty('type', 'kiosk_receivemoney');
					thread.setProperty('status', 'closed');
					y.persistThread(thread);

				}, text, { 'direct_to' : recipientId });
			});
		});
	});

	app.get('/transaction/:id', function (req, res) {
		authCheck(req, res, function () {
			var userId, account, booking, item, sender, recipient;

			userId = req.userId;
			account = accounts.get(userId);
			booking = account.booking(req.params.id);
			item = items.get(booking.itemId());
			sender = y.user(booking.sender());
			recipient = y.user(booking.recipient());

			res.render('transaction.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'account' : account,
				'booking' : booking,
				'item' : item, 
				'sender' : sender,
				'recipient' : recipient
			});
		});
	});

	app.get('/tally', function (req, res) {
		authCheck(req, res, function () {
			var userId, allItems, item, stockableItems;

			userId = req.userId;
			allItems = items.all();
			stockableItems = [];

			for (var itemId in allItems) {
				if (allItems.hasOwnProperty(itemId)) {
					item = items.get(itemId);
					if (item.isStockable()) { stockableItems.push(item); }
				}
			}

			res.render('tally.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'users' : y.users(),
				'items' : stockableItems
			});
		});

	});

	app.post('/tally', function (req, res) {
		authCheck(req, res, function () {
			var userId, user, amount, account,
				itemIds, marks, wait, recString,
				item, mark, rec, bookings;

			bookings = [];
			userId = req.userId;
			user = parseInt(req.body.user, 10);
			amount = parseInt(req.body.amount * 100, 10);
			account = accounts.get(user);

			recString = String();

			itemIds = req.body.item;
			marks = req.body.marks;

			if (!Array.isArray(itemIds)) { itemIds = [itemIds]; }
			if (!Array.isArray(marks)) { marks = [marks]; }
			wait = itemIds.length - 1;

			for (var i = 0; i < itemIds.length; i++) {
				item = items.get(itemIds[i]);
				mark = parseInt(marks[i], 10);

				if (mark) {
					rec = {
						'item' : item,
						'marks' : mark,
						'total' : mark * item.price()
					};

					if (i !== 0) { recString += ', '; }
					recString += rec.marks + ' x ' + rec.item.name();

					tallyCarryOver(user, rec, function (err, bookingId, rec) {
						var stock, text;

						kioskLogger.log(userId, account, account.booking(bookingId));
						bookings.push(account.booking(bookingId));

						if (rec.item.isStockable()) {
							stock = stocks.get(rec.item.id());
							stock.update({
								'bookingId' : bookingId,
								'type' : 'consumption',
								'change' : rec.item.ration() * rec.marks * -1
							});
						}

						--wait;
						if (wait < 0) {
							res.render('tallyok.ejs', {
								'layout' : 'layout.ejs',
								'req' : req,
								'res' : res,
								'balance' : account.balance(),
								'bookings' : bookings
							});

							text = messages.get('kiosk_tally', {
								'name' : y.user(user).fullName(),
								'balance' : formatMoney(account.balance() / 100),
								'recs' : recString
							});

							y.sendMessage(function (error, msg) {
								var thread = y.thread(msg.threadId());
								thread.setProperty('type', 'kiosk_tally_carry_over');
								thread.setProperty('status', 'closed');
								y.persistThread(thread);

							}, text, { 'direct_to' : user });
						}
					});

				} else {
					--wait;
				}
			}
		});
	});

	app.get('/initialize', function (req, res) {
		authCheck(req, res, function () {
			var userId = req.userId;

			res.render('initialize.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'users' : y.users()
			});
		});

	});

	app.post('/initialize', function (req, res) {
		authCheck(req, res, function () {
			var userId, user, amount, account, text;

			userId = req.userId;
			user = parseInt(req.body.user, 10);
			amount = parseInt(req.body.amount * 100, 10);
			account = accounts.get(user);

			account.initialize(amount, function (err, bookingId) {
				res.render('initializeok.ejs', {
					'layout' : 'layout.ejs',
					'req' : req,
					'res' : res,
					'balance' : account.balance(),
					'booking' : account.booking(bookingId)
				});

				kioskLogger.log(userId, account, account.booking(bookingId));

				text = messages.get('kiosk_initialize', {
					'name' : y.user(user).fullName(),
					'balance' : formatMoney(account.balance() / 100)
				});

				y.sendMessage(function (error, msg) {
					var thread = y.thread(msg.threadId());
					thread.setProperty('type', 'kiosk_initialization');
					thread.setProperty('status', 'closed');
					y.persistThread(thread);

				}, text, { 'direct_to' : user });
			});
		});
	});


	app.get('/paid/:id', function (req, res) {
		authCheck(req, res, function () {
			var userId, account, booking, item;

			userId = req.userId;
			account = accounts.get(userId);
			booking = account.booking(req.params.id);
			item = items.get(booking.itemId());

			res.render('paid.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'account' : accounts.get(userId),
				'booking' : booking,
				'item' : item
			});
		});

	});

	app.get('/account/:user?', function (req, res) {
		authCheck(req, res, function () {
			var userId = req.userId;
			if (req.params.user) { userId = parseInt(req.params.user, 10); }

			res.render('account.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'account' : accounts.get(userId)
			});
		});
	});

	app.get('/booking/:id', function (req, res) {
		authCheck(req, res, function () {
			var userId, account, booking, item;

			userId = req.userId;
			account = accounts.get(userId);
			booking = account.booking(req.params.id);
			item = items.get(booking.itemId());

			res.render('booking.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'account' : account,
				'booking' : booking,
				'item' : item
			});
		});

	});

	app.get('/overview', function (req, res) {
		authCheck(req, res, function () {
			var accs, users;

			accs = {};
			users = y.users();

			for (var userId in users) {
				if (users.hasOwnProperty(userId)) {
					accs[userId] = accounts.get(userId);
				}
			}
			
			var itemList, info, stock;

			itemList = items.all();
			info = [];

			for (var itemId in itemList) {
				if (itemList.hasOwnProperty(itemId)) {
					if (itemList[itemId].isStockable()) {
						stock = stocks.get(itemId);
						info.push({
							'info' : stock.info(),
							'item' : itemList[itemId]
						});
					}
				}
			}

			res.render('overview.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'accounts' : accs,
				'stockInfo' : info,
				'users' : users
			});
		});
	});

	app.get('/log', function (req, res) {
		authCheck(req, res, function () {
			res.render('log.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'log' : kioskLogger.entries(),
				'users' : y.users()
			});
		});
	});

	app.get('/stocklist', function (req, res) {
		authCheck(req, res, function () {
			var itemList, info, stock;

			itemList = items.all();
			info = [];

			for (var itemId in itemList) {
				if (itemList.hasOwnProperty(itemId)) {
					if (itemList[itemId].isStockable()) {
						stock = stocks.get(itemId);
						info.push({
							'info' : stock.info(),
							'item' : itemList[itemId]
						});
					}
				}
			}

			res.render('stocklist.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'stockInfo' : info
			});
		});
	});

	app.get('/items', function (req, res) {
		authCheck(req, res, function () {
			res.render('items.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'items' : items.all()
			});
		});
	});

	app.get('/item/new', function (req, res) {
		authCheck(req, res, function () {
			var item;

			item = new Item();

			res.render('edititem.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'item' : item
			});
		});
	});

	app.get('/item/:id', function (req, res) {
		authCheck(req, res, function () {
			var userId, item;

			userId = req.userId;
			item = items.get(req.params.id);

			res.render('item.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'item' : item
			});
		});

	});

	app.get('/item/:id/edit', function (req, res) {
		authCheck(req, res, function () {
			var item;

			item = items.get(req.params.id);

			res.render('edititem.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'item' : item
			});
		});
	});

	app.post('/item/:id/edit', function (req, res) {
		authCheck(req, res, function () {
			var item, itemId, newData;

			itemId = req.params.id;
			if (itemId === 'new') {
				item = items.create();
			} else {
				item = items.get(req.params.id);
			}

			newData = {
				'id' : item.id(),
				'name' : sanitize(req.body.name).trim(),
				'description' : sanitize(req.body.description).trim(),
				'price' : parseInt(sanitize(req.body.price).toFloat() * 100, 10),
				'displayPrice' : sanitize(req.body.displayprice).trim(),
				'buyable' : sanitize(req.body.buyable).toBoolean(),
				'stockable' : sanitize(req.body.stockable).toBoolean(),
				'unit' : sanitize(req.body.unit).trim(),
				'ration' : sanitize(req.body.ration).toInt()
			};

			item.updateData(newData);
			items.persist();

			res.redirect('/items');
		});

	});

	app.get('/item/:id/changes', function (req, res) {
		authCheck(req, res, function () {
			var item;

			item = items.get(req.params.id);

			res.render('itemchanges.ejs', {
				'layout' : 'layout.ejs',
				'req' : req,
				'res' : res,
				'item' : item
			});
		});

	});

	app.get('/item/:id/delete', function (req, res) {
		authCheck(req, res, function () {
			var item;

			items.remove(req.params.id);
			items.persist();

			res.redirect('/items');
		});
	});

	archiveUserAccount = function (user) {

		var account = accounts.get(user.id());

		if (account.bookings().length > 1) {
			account.archive(function (err, bookingId) {
				var now, text;

				now = new Date();
				text = messages.get('kiosk_monthly_archive', {
					'name' : user.fullName(),
					'month' : now.toString('MMMM yyyy'),
					'balance' : formatMoney(account.balance() / 100)
				});

				kioskLogger.log(account, account.booking(bookingId));

				y.sendMessage(function (error, msg) {
					logger.info('kiosk monthly archive for ' + user.username());
					var thread = y.thread(msg.threadId());
					thread.setProperty('type', 'kiosk_monthly_archive');
					thread.setProperty('status', 'closed');
					y.persistThread(thread);

				}, text, { 'direct_to' : user.id() });
			});
		}
	};

	archiveAll = function () {
		var users = y.users();

		for (var userId in users) {
			if (users.hasOwnProperty(userId)) {
				archiveUserAccount(users[userId]);
			}
		}
	};

	allBookings = function () {
		var b, users, account;

		b = [];
		users = y.users();

		for (var userId in users) {
			if (users.hasOwnProperty(userId)) {
				account = accounts.get(userId);
				b = b.concat(account.bookings());
			}
		}

		return b;
	};

	archiverCron = new cron.CronJob('0 0 8 28 * *', function () {
//	new cron.CronJob('0 12 1 * * *', function () {
		archiveAll();
	});

};
