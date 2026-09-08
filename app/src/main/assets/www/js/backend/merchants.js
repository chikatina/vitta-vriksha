/*
 * Which vendor a message names, and what kind of spending that is.
 *
 * Two tiers, because a phone should not think twice about the same shop:
 *
 *   1. The merchant key. A normalised form of the vendor name that a learned rule and a
 *      transaction row both store, so recognising a repeat is a lookup rather than a
 *      search. Most spending is repeat spending, so most messages stop here.
 *   2. The dictionary below, searched with an Aho-Corasick automaton. One pass over the
 *      text finds every keyword at once, so adding the five hundredth vendor costs the
 *      same per message as the first. Only a key nobody has seen before gets this far,
 *      and the answer is written back into tier one, so a given vendor is scanned once
 *      in the lifetime of the install.
 *
 * The dictionary holds generic words and nationally known brands only. No place names,
 * no neighbourhood shops, no discoms: which electricity board bills you says which state
 * you live in, and this file ships to everybody. Anything local is something the user
 * taught their own copy, and that lives in the database, not here.
 */

/* ------------------------------------------------------------- the dictionary */

/*
 * Keyword to category. Categories are the ones in DEFAULT_CATEGORIES; a name that is not
 * one of those would file transactions under a category no screen shows.
 *
 * Longer keywords win, so "coffee day" beats "coffee" and "big basket" beats "basket".
 */
const VENDORS = {
  Groceries: [
    'bigbasket', 'big basket', 'bbdaily', 'bb daily', 'blinkit', 'blink commerce', 'zepto',
    'zeptonow', 'swiggy instamart', 'instamart', 'dunzo', 'dmart', 'd mart',
    'avenue supermart', 'jiomart', 'jio mart', 'licious', 'freshtohome', 'fresh to home',
    'country delight', 'otipy', 'zappfresh', 'meatigo', 'id fresh', 'mother dairy', 'amul',
    'reliance fresh', 'reliance smart', 'more retail', 'spencers', 'nature basket',
    'natures basket', 'star bazaar', 'smart bazaar', 'big bazaar', 'vishal mega mart',
    'easyday', 'grofers', 'milkbasket', 'cash and carry',
    // What a shop with no brand behind it writes on its board, and what a statement
    // prints for one. These carry most of the weight outside the metros.
    'supermarket', 'hypermarket', 'super market', 'hyper market', 'super mart', 'mini mart',
    'kirana', 'grocery', 'groceries', 'grocers', 'grocer', 'greengrocer', 'provision',
    'provisions', 'provision store', 'general store', 'general stores', 'departmental',
    'departmental store', 'daily needs', 'convenience store', 'food bazaar', 'fresh mart',
    'sabzi', 'sabzi mandi', 'mandi', 'vegetable', 'vegetables', 'fruits', 'fruit mart',
    'butcher', 'meat shop', 'meats', 'poultry', 'chicken shop', 'fish market', 'seafood',
    'eggs', 'dairy', 'dairy farm', 'milk', 'milk dairy', 'dry fruits', 'masala', 'spices',
    'namkeen', 'atta chakki', 'chakki', 'flour mill', 'staples', 'ration', 'ration shop',
    'organic store', 'organics', 'bakery mart',
  ],
  Dining: [
    'zomato', 'swiggy', 'eternal', 'bundl', 'dineout', 'eazydiner', 'dominos', 'domino',
    'pizza hut', 'la pinoz', 'smokin joes', 'mcdonald', 'kfc', 'subway', 'taco bell',
    'burger king', 'burger singh', 'jumboking', 'wendys', 'popeyes', 'papa johns',
    'papa john', 'starbucks', 'costa coffee', 'cafe coffee day', 'coffee day', 'barista',
    'chaayos', 'chai point', 'chai sutta', 'third wave', 'blue tokai', 'dunkin',
    'krispy kreme', 'mad over donuts', 'cinnabon', 'wow momo', 'wow china', 'chinese wok',
    'faasos', 'behrouz', 'ovenstory', 'box8', 'eatsure', 'rebel foods', 'curefoods',
    'freshmenu', 'eatfit', 'sweet truth', 'bakingo', 'cakezone', 'biryani',
    'biryani by kilo', 'mainland china', 'haldiram', 'bikanervala', 'barbeque nation',
    'barbequenation', 'barbecue', 'barbeque', 'theobroma', 'monginis', 'baskin robbins',
    'naturals ice', 'natural ice cream', 'kwality walls', 'amul parlour', 'keventers',
    // Meal cards. A food-only wallet, so the spend behind one is a meal whoever took it.
    'pluxee', 'sodexo', 'smartq', 'hungerbox',
    // Generic words, and the dish a small place names itself after.
    'burger', 'burgers', 'pizza', 'pizzas', 'pizzeria', 'restaurant', 'restaurants',
    'restro', 'dining', 'diner', 'eatery', 'eateries', 'dhaba', 'dhabha', 'bhojanalay',
    'bakery', 'bakers', 'baker', 'bakehouse', 'bake house', 'patisserie', 'pastry',
    'pastries', 'cake', 'cakes', 'cake shop', 'cafe', 'cafeteria', 'coffee', 'coffee shop',
    'coffee house', 'espresso', 'roasters', 'roastery', 'chai', 'tea stall', 'tea house',
    'food court', 'food plaza', 'food joint', 'food truck', 'fast food', 'street food',
    'foods', 'takeaway', 'take away', 'catering', 'caterers', 'canteen', 'kitchen',
    'kitchens', 'tiffin', 'snacks', 'snack bar', 'refreshments', 'sweets', 'sweet shop',
    'mithai', 'mithaiwala', 'confection', 'chocolate', 'chocolates', 'juice', 'milkshake',
    'ice cream', 'icecream', 'ice cream parlour', 'creamery', 'gelato', 'kulfi', 'falooda',
    'donut', 'donuts', 'doughnut', 'waffle', 'waffles', 'pancake', 'sandwich', 'sandwiches',
    'noodles', 'momo', 'momos', 'sushi', 'ramen', 'shawarma', 'kebab', 'kabab', 'tandoor',
    'tandoori', 'grill', 'grills', 'bistro', 'curry', 'dosa', 'idli', 'vada pav',
    'pav bhaji', 'chaat', 'thali', 'paratha', 'parantha', 'samosa', 'kachori', 'jalebi',
    'chinese food', 'brewery', 'brewhouse', 'brewing', 'brewpub', 'taproom', 'pub', 'beer',
    'wines', 'wine shop', 'liquor', 'spirits', 'distillery', 'cocktail',
  ],
  Transport: [
    'uber', 'ola', 'olacabs', 'ola cabs', 'rapido', 'meru', 'indrive', 'blablacar',
    'quick ride', 'quickride', 'zoomcar', 'revv', 'yulu', 'chalo',
    'fastag', 'fastag recharge', 'fastag toll', 'fastag payment',
    'toll recharge', 'parkplus', 'park plus',
    'toll', 'toll plaza', 'parking', 'parking lot', 'parking fee', 'valet',
    'metro rail', 'metro ticket', 'bus ticket', 'bus fare', 'transport corp', 'roadways',
    'auto rickshaw', 'rickshaw', 'cab', 'cabs', 'taxi', 'taxis', 'bike taxi', 'carpool',
    'car rental', 'car hire', 'bike rental', 'self drive', 'car wash', 'carwash',
    'car service', 'car care', 'garage', 'motor garage', 'automobile', 'automotive',
    'motors', 'tyre', 'tyres', 'puncture', 'lubricants', 'spare parts',
    'driving school', 'rto',
  ],
  Fuel: [
    'shell', 'hpcl', 'hp petrol', 'iocl', 'indian oil', 'indianoil', 'bharat petroleum',
    'bpcl', 'nayara', 'essar oil', 'jio bp', 'ather', 'chargepoint', 'statiq',
    'petrol', 'petrol pump', 'diesel', 'fuel', 'fuel station', 'petroleum', 'filling station',
    'gas station', 'service station', 'charging station', 'charging point', 'ev charging',
    'cng', 'cng pump', 'cng station', 'engine oil',
  ],
  Travel: [
    'irctc', 'confirmtkt', 'railyatri', 'trainman', 'makemytrip', 'goibibo', 'yatra',
    'cleartrip', 'easemytrip', 'ixigo', 'redbus', 'abhibus', 'indigo', 'air india',
    'vistara', 'akasa', 'spicejet', 'air asia', 'airasia', 'emirates', 'qatar airways',
    'lufthansa', 'singapore airlines', 'british airways', 'etihad', 'thai airways',
    'malaysia airlines', 'cathay pacific', 'air france', 'turkish airlines', 'klm',
    'united airlines', 'american airlines', 'delta airlines', 'oman air', 'gulf air',
    'flydubai', 'air arabia', 'srilankan airlines', 'jazeera airways',
    'oyo', 'treebo', 'fabhotels', 'taj hotel', 'itc hotel', 'marriott', 'hyatt',
    'radisson', 'lemon tree', 'ginger hotel', 'ibis', 'novotel', 'accor', 'holiday inn',
    'hilton', 'sheraton', 'westin', 'the leela', 'oberoi hotel', 'trident hotel',
    'sarovar', 'wyndham', 'best western', 'bloom hotel', 'zostel', 'hostelworld',
    'airbnb', 'booking com', 'agoda', 'expedia', 'trivago', 'klook', 'tripadvisor',
    'trip com', 'skyscanner', 'thomas cook', 'sotc', 'cox and kings', 'veena world',
    'thrillophilia', 'club mahindra', 'sterling holiday', 'stayvista',
    // Airport lounges reach the statement through an aggregator, not the airport.
    'dreamfolks', 'loungeone', 'plaza premium', 'priority pass',
    'hotel', 'hotels', 'resort', 'resorts', 'airline', 'airlines', 'airways', 'airport',
    'aviation', 'flight', 'flights', 'air ticket', 'train ticket', 'bus booking',
    'travel', 'travels', 'travel agency', 'tour', 'tours', 'tour operator', 'tourism',
    'trip', 'trips', 'itinerary', 'holiday', 'vacation', 'sightseeing', 'excursion',
    'lounge', 'duty free', 'homestay', 'homestays', 'guest house', 'guesthouse', 'lodge',
    'lodging', 'hostel', 'villa', 'villas', 'camping', 'campsite', 'trekking', 'safari',
    'houseboat', 'railway', 'cruise', 'cruises', 'ferry', 'visa fee', 'e visa',
    'visa application', 'immigration', 'passport', 'baggage',
  ],
  Utilities: [
    'electricity', 'electricity bill', 'electricity board', 'elec bill', 'electric bill',
    'power bill', 'power supply', 'energy bill', 'discom', 'gas bill', 'piped gas',
    'gas booking', 'gas cylinder', 'gas agency', 'gas connection', 'cylinder booking',
    'lpg', 'indane', 'bharatgas', 'bharat gas', 'hp gas',
    'water bill', 'water charges', 'water supply', 'sewage', 'sewerage',
    'broadband', 'fibernet', 'fiber', 'fibre', 'internet', 'wifi', 'wi fi', 'landline',
    'telephone', 'telecom', 'postpaid', 'prepaid', 'recharge', 'mobile recharge',
    'mobile bill', 'phone bill', 'data pack', 'talktime', 'topup', 'top up',
    'dth', 'dth recharge', 'cable tv', 'cable operator', 'set top box', 'tata play',
    'tata sky', 'dish tv', 'sun direct', 'airtel', 'airtel xstream', 'xstream', 'jio',
    'jiofiber', 'jio fiber', 'vodafone', 'bsnl', 'mtnl', 'hathway', 'tikona', 'spectra',
    'railwire', 'you broadband',
    // Biller codes an issuer prints instead of the biller's name. They are opaque, they
    // are the same for every customer of that bank, and a boundary-checked match will
    // not find them inside a longer run, so each one is spelled out.
    'excitel', 'act fibernet', 'act broadband', 'bbps', 'bbpsbill', 'bbpsno', 'ccbbpsno',
    'hdfcspelec', 'hdfcspgas', 'hdfcspwat', 'billdesk', 'bill payment', 'utility',
    'utilities',
  ],
  Shopping: [
    'amazon', 'flipkart', 'myntra', 'ajio', 'tatacliq', 'meesho', 'nykaa', 'tata cliq',
    'snapdeal', 'shopsy', 'firstcry', 'purplle', 'limeroad', 'bewakoof', 'urbanic',
    'shein', 'ebay', 'aliexpress', 'temu', 'etsy', 'olx', 'zara', 'uniqlo', 'levis',
    'pantaloons', 'westside', 'zudio', 'lifestyle', 'shoppers stop', 'max fashion',
    'reliance trends', 'marks and spencer', 'forever 21', 'jack and jones', 'vero moda',
    'jockey', 'clovia', 'zivame', 'van heusen', 'allen solly', 'peter england',
    'louis philippe', 'raymond', 'wrangler', 'us polo', 'decathlon', 'adidas', 'nike',
    'puma', 'reebok', 'asics', 'new balance', 'skechers', 'crocs', 'woodland', 'redtape',
    'red tape', 'hush puppies', 'metro shoes', 'liberty shoes', 'campus shoes', 'bata',
    'croma', 'reliance digital', 'vijay sales', 'apple store', 'apple india', 'samsung',
    'oneplus', 'xiaomi', 'realme', 'oppo', 'vivo', 'motorola', 'lenovo', 'asus', 'acer',
    'dell', 'boat lifestyle', 'jbl', 'sony', 'lg electronics', 'whirlpool', 'godrej',
    'havells', 'philips', 'prestige', 'hawkins', 'milton', 'borosil', 'cello',
    'ikea', 'pepperfry', 'urban ladder', 'nilkamal', 'godrej interio', 'wakefit',
    'sleepwell', 'duroflex', 'kurlon', 'home centre', 'asian paints', 'berger paints',
    'titan', 'tanishq', 'titan eye', 'kalyan jewel', 'malabar gold', 'joyalukkas',
    'senco gold', 'pc jeweller', 'reliance jewels', 'bluestone', 'melorra', 'caratlane',
    'candere', 'lenskart', 'body shop', 'mamaearth', 'sugar cosmetics', 'plum goodness',
    'the man company', 'beardo', 'wow skin', 'forest essentials', 'biotique', 'himalaya',
    'crossword', 'mr diy',
    // Software and subscriptions bought outright. Nothing here is a media service; those
    // sit under Entertainment or Subscriptions.
    'adobe', 'microsoft', 'canva', 'figma', 'dropbox', 'openai', 'chatgpt', 'github',
    'godaddy', 'namecheap', 'hostinger', 'porkbun', 'bigrock', 'digitalocean',
    'fastspring',
    'jewellers', 'jewellery', 'furniture', 'furnishing', 'electronics', 'appliances',
    'hardware', 'sanitaryware', 'plywood', 'tiles', 'paints', 'mall', 'shop', 'store',
    'stores', 'megastore', 'outlet', 'retail', 'wholesale', 'mart', 'bazaar', 'emporium',
    'showroom', 'boutique', 'garments', 'apparel', 'clothing', 'footwear', 'shoes',
    'ecommerce', 'e commerce', 'online store', 'book store', 'bookstore', 'books',
    'toys', 'toy store', 'watches',
    'gyftr', 'smartbuy', 'qwikcilver', 'woohoo',
  ],
  Subscriptions: [
    'netflix', 'amazon prime', 'prime video', 'hotstar', 'jiohotstar', 'disney',
    'sonyliv', 'sony liv', 'zee5', 'jiocinema', 'voot', 'mubi', 'lionsgate play',
    'apple tv', 'crunchyroll', 'discovery plus', 'erosnow', 'shemaroo',
    'spotify', 'gaana', 'wynk', 'saavn', 'jiosaavn', 'apple music', 'amazon music',
    'youtube premium', 'youtube music', 'apple media', 'audible',
  ],
  Entertainment: [
    'bookmyshow', 'ticketnew', 'paytm insider', 'pvr', 'inox', 'pvr inox', 'cinepolis',
    'carnival cinema', 'imax', 'youtube', 'kindle',
    'patreon', 'twitch', 'steam', 'steamgames', 'epic games', 'playstation', 'xbox',
    'nintendo', 'krafton', 'bgmi', 'garena', 'roblox', 'riot games', 'ubisoft',
    'google play', 'googleplay', 'app store',
    'cinema', 'cinemas', 'movie', 'movies', 'theatre', 'cineplex', 'multiplex', 'gaming',
    'games', 'esports', 'arcade', 'amusement', 'water park', 'theme park', 'funzone',
    'bowling', 'snooker', 'billiards', 'paintball', 'trampoline', 'karting', 'go karting',
    'zoo', 'aquarium', 'planetarium', 'museum', 'concert', 'live show', 'comedy show',
    'stand up comedy', 'ticketing', 'entertainment', 'club house', 'turf', 'hudle',
    'stadium', 'sports club',
  ],
  Medical: [
    'apollo', 'apollo 247', 'medplus', 'pharmeasy', 'netmeds', 'tata 1mg', '1mg',
    'wellness forever', 'truemeds', 'zeno health', 'practo', 'mfine',
    'pristyn care', 'clove dental', 'sabka dentist', 'cloudnine',
    'fortis', 'max healthcare', 'manipal', 'aster', 'narayana health', 'medanta',
    'thyrocare', 'lal pathlabs', 'srl diagnostics', 'agilus', 'healthians',
    'orange health', 'metropolis', 'redcliffe', 'vision express',
    'pharmacy', 'pharma', 'chemist', 'chemists', 'druggist',
    'drug store', 'medical', 'medicals', 'medico', 'medicos', 'medicine', 'medicines',
    'medicare', 'hospital', 'hospitals', 'clinic', 'clinics', 'polyclinic', 'nursing',
    'nursing home', 'dental', 'dentist', 'orthodontic', 'diagnostic', 'diagnostics',
    'pathology', 'pathlab', 'pathlabs', 'lab test', 'blood test', 'imaging', 'radiology',
    'scan centre', 'scan center', 'ultrasound', 'x ray', 'ecg', 'mri', 'physio',
    'physiotherapy', 'ambulance', 'orthopedic', 'surgery', 'surgical',
  ],
  Health: [
    'health', 'healthcare', 'therapy', 'counselling', 'psychiatry', 'psychologist',
    'mental health', 'optical', 'optician', 'ophthalmic', 'eye care', 'eye hospital',
    'ayurved', 'ayurveda', 'ayurvedic', 'homeopath', 'homeopathy', 'homeopathic',
    'vaccine', 'vaccination', 'immunisation',
  ],
  Pets: [
    'pet shop', 'pet store', 'pet supplies', 'veterinary', 'vet clinic', 'pet clinic',
    'heads up for tails', 'supertails', 'pet food', 'dog food', 'cat food', 'pet grooming',
  ],
  Fitness: [
    'cult fit', 'cultfit', 'healthify', 'golds gym', 'gold gym', 'fitness first',
    'talwalkars', 'snap fitness', 'anytime fitness',
    'gym', 'fitness', 'yoga', 'zumba', 'crossfit', 'pilates', 'aerobics',
  ],
  'Personal Care': [
    'urban company', 'urbanclap', 'looks salon', 'jawed habib', 'lakme salon',
    'naturals salon', 'green trends', 'toni and guy', 'bblunt', 'affinity salon',
    'kaya skin', 'vlcc', 'enrich', 'bodycraft',
    'salon', 'salons', 'spa', 'barber', 'beauty', 'parlour', 'parlor', 'unisex',
    'grooming', 'cosmetic', 'cosmetics', 'skincare', 'haircut', 'hair', 'nails',
    'manicure', 'pedicure', 'waxing', 'threading', 'facial', 'makeup', 'mehendi',
    'tattoo', 'piercing', 'massage', 'aesthetics', 'wellness', 'laundry', 'dry cleaner',
    'dry cleaning', 'ironing',
  ],
  School: [
    'school fee', 'school fees', 'junior college', 'tuition', 'tuition fee',
    'tutorial', 'tutorials', 'tutor', 'coaching', 'classes',
    'vidyalaya', 'vidhyalaya', 'gurukul', 'playschool', 'play school',
    'preschool', 'pre school', 'kindergarten', 'montessori', 'eurokids', 'kidzee',
    'kumon', 'fiitjee', 'aakash', 'allen career',
  ],
  Education: [
    'byju', 'unacademy', 'vedantu', 'physics wallah', 'toppr', 'whitehat', 'cuemath',
    'extramarks', 'testbook', 'adda247', 'oliveboard',
    'coursera', 'udemy', 'edx', 'skillshare',
    'khan academy', 'pluralsight', 'datacamp', 'codecademy', 'chegg', 'upgrad',
    'simplilearn', 'great learning', 'scaler', 'newton school', 'masai school',
    'linkedin learning',
    'college fee', 'college fees', 'hostel fee',
    'course fee', 'exam fee', 'exam fees', 'entrance exam',
    'training institute', 'certification', 'seminar', 'academy', 'institute', 'university',
    'polytechnic', 'shiksha', 'admission', 'library', 'stationery', 'stationers',
    'textbook', 'textbooks', 'edutech', 'edtech', 'elearning', 'e learning',
  ],
  'Investment Outflow': [
    'zerodha', 'groww', 'upstox', 'angel one', 'angelbroking', 'icici direct',
    'hdfc securities', 'kotak securities', 'motilal oswal', 'sharekhan', '5paisa',
    'fyers', 'paytm money', 'kuvera', 'indmoney', 'etmoney', 'et money', 'scripbox',
    'smallcase', 'wealthdesk', 'vested', 'kfintech', 'camsonline', 'mfcentral',
    'dhan', 'geojit', 'shoonya', 'finvasia', 'samco', 'alice blue', 'navi',
    'binance', 'coindcx', 'wazirx', 'coinswitch', 'zebpay',
    'mutual fund', 'mutual funds', 'funds management', 'asset management', 'nse', 'bse',
    'cdsl', 'nsdl', 'demat', 'depository', 'broking', 'brokerage', 'securities',
    'sip', 'systematic investment', 'lumpsum', 'nps', 'ppf', 'epf', 'epfo',
    'provident fund', 'sukanya', 'gold bond', 'sovereign gold', 'gold etf', 'etf',
    'bharat bond', 'irfc', 'bonds', 'debenture', 'ipo', 'asba', 'shares', 'elss', 'folio',
    'amc', 'clearing corp', 'clearing corporation', 'iccl', 'indian clearing corporation',
    'indian clearing corp', 'bse clearing', 'nse clearing', 'ncl', 'ccil', 'clearing corp of india',
    'tata mutual fund', 'sbi mutual fund', 'hdfc mutual fund', 'nippon', 'uti mutual fund',
    'axis mutual fund', 'mirae asset', 'parag parikh', 'ppfas', 'quant mutual fund',
    'bandhan mutual fund', 'dsp mutual fund', 'franklin templeton', 'kotak mutual fund',
    'icici prudential mutual fund', 'edelweiss',
    'sip debit', 'sip instalment', 'sip installment', 'sip purchase', 'nach debit', 'ach debit',
    'e-nach debit', 'nach-sip', 'ach-sip', 'mf sip', 'mutual fund sip', 'sip deduction',
    'trading account', 'trading debit', 'demat debit', 'demat charges', 'stock broker',
    'fixed deposit', 'term deposit', 'recurring deposit',
    'investment', 'investments', 'portfolio', 'crypto',
  ],
  'Insurance & Tax': [
    'hdfc life', 'icici prudential', 'sbi life', 'max life', 'bajaj allianz', 'tata aia',
    'tata aig', 'hdfc ergo', 'kotak life', 'pnb metlife', 'bharti axa', 'ageas federal',
    'aviva', 'iffco tokio', 'go digit', 'digit insurance', 'reliance general',
    'new india assurance', 'oriental insurance', 'united india insurance',
    'national insurance', 'star health', 'care health', 'niva bupa', 'manipal cigna',
    'acko', 'policybazaar', 'renewbuy', 'coverfox', 'insurance dekho', 'turtlemint',
    'lic', 'lic of india',
    'insurance', 'health insurance', 'life insurance', 'medical insurance',
    'motor insurance', 'vehicle insurance', 'term plan', 'mediclaim', 'assurance',
    'premium', 'renewal premium', 'policy', 'policy renewal',
    'income tax', 'cbdt', 'itr', 'cleartax', 'quicko', 'taxbuddy', 'gst', 'gstn', 'tds',
    'advance tax', 'self assessment', 'challan', 'property tax', 'house tax',
    'water tax', 'vehicle tax', 'professional tax', 'road tax', 'stamp duty',
    'municipal', 'itdcpc',
  ],
  'Rent & Housing': [
    'nobroker', 'magicbricks', 'housing com', '99acres', 'square yards', 'proptiger',
    'nestaway', 'stanza living', 'colive', 'coliving', 'zolo', 'rentomojo', 'furlenco',
    'rent', 'house rent', 'monthly rent', 'rental', 'tenant', 'landlord', 'lease',
    'paying guest', 'society maintenance', 'society charges', 'maintenance charge',
    'flat maintenance', 'housing society', 'chs', 'apartment', 'apartments',
    'home loan', 'housing loan', 'mortgage', 'brokerage fee', 'packers', 'movers',
    'builder', 'builders', 'developers', 'realty', 'estates', 'property', 'properties',
    'construction', 'renovation', 'interiors', 'plumber', 'electrician', 'carpenter',
    'housekeeping', 'residency', 'residences',
  ],
  'Gifts & Donations': [
    'ferns n petals', 'fnp', 'floweraura', 'igp com', 'archies', 'winni',
    'gift card', 'gift shop', 'gift voucher', 'gifting', 'gifts', 'flowers', 'florist',
    'bouquet', 'greeting card', 'donation', 'donations', 'donate', 'charity',
    'charitable', 'charitable trust', 'relief fund', 'foundation', 'welfare', 'ngo',
    'trust fund', 'seva', 'daan', 'dakshina', 'orphanage', 'ashram', 'sansthan',
    'temple', 'mandir', 'church', 'gurudwara', 'masjid', 'mosque', 'dargah',
    'akshaya patra', 'milaap', 'ketto', 'giveindia', 'goonj', 'smile foundation',
    'helpage', 'save the children', 'unicef', 'ramakrishna mission', 'iskcon',
  ],
  // Money arriving. A credit is worth splitting up: pay, work billed, yield and a
  // reversal all read the same to the parser and mean different things on a chart.
  Salary: [
    'salary', 'salary credit', 'monthly salary', 'payroll', 'wages', 'stipend',
    'arrears', 'bonus', 'incentive', 'overtime', 'gratuity', 'pension', 'ex gratia',
    'reimbursement',
  ],
  Freelance: [
    'freelance', 'freelancer', 'upwork', 'fiverr', 'toptal', 'gumroad', 'adsense',
    'google adsense', 'consultancy', 'consulting fee', 'professional fee', 'retainer',
    'honorarium', 'royalty', 'royalties',
  ],
  'Interest & Dividends': [
    'dividend', 'dividends', 'interim dividend', 'final dividend', 'interest credited',
    'interest earned', 'savings interest', 'deposit interest', 'fd interest',
    'accrued interest', 'maturity proceeds',
  ],
  'Refunds & Cashback': [
    'refund', 'refunds', 'refunded', 'cashback', 'cash back', 'chargeback', 'reversal',
    'reversed',
  ],
  'Loans & EMI': [
    'emi', 'loan', 'loan emi', 'loan account', 'loan repayment', 'personal loan',
    'car loan', 'auto loan', 'two wheeler loan', 'education loan', 'gold loan',
    'home loan emi', 'housing loan emi', 'lap loan', 'mortgage',
    'instalment', 'installment', 'instalments', 'installments', 'instl',
    'equated monthly instalment', 'equated monthly installment',
    'loan instalment', 'loan installment', 'emi payment', 'emi debit',
    'installment debit', 'instalment debit', 'monthly emi',
    'nach mandate', 'ecs mandate', 'ach mandate', 'nach debit', 'ach debit', 'ecs debit',
    'nach emi', 'ach emi', 'mandate debit', 'overdraft', 'foreclosure',
    'towards ecs', 'towards nach', 'towards ach', 'towards emi', 'towards loan', 'ecs',
    'bajaj finserv', 'bajaj finance', 'hdb financial', 'tata capital', 'muthoot',
    'manappuram', 'iifl finance', 'shriram finance', 'moneyview', 'kreditbee',
    'paysense', 'cashe', 'lazypay', 'simpl', 'zestmoney', 'dmi finance',
    'cholamandalam', 'hero fincorp', 'piramal finance', 'smfg', 'kotak prime',
    'mahindra finance', 'axis finance', 'credila', 'avanse', 'incred',
    'chits', 'chit fund',
  ],
  'Credit Card': [
    'cred', 'cheq', 'sbi card', 'sbicard', 'hdfc card', 'icici card', 'axis card',
    'kotak card', 'rbl card', 'indusind card', 'idfc card', 'onecard', 'one card',
    'au small finance card', 'amex', 'american express', 'bob card', 'bobcard',
    'sc card', 'standard chartered card', 'stanchart card', 'scb card', 'citi card', 'citibank card',
    'credit card payment', 'credit card bill', 'card bill payment', 'cc payment',
    'cc bill payment', 'card payment', 'autopay cc bill', 'cc bill', 'credit card outstanding',
    'credit card dues', 'card dues', 'pay credit card', 'credit card settlement',
  ],
};

/* ----------------------------------------------------------- the automaton */

/**
 * An Aho-Corasick keyword index.
 *
 * Built once from the dictionary. `find` walks the text a character at a time, following
 * a goto edge where one exists and a failure link where none does, so the whole
 * dictionary is tested at every position without ever backing up. The cost is the length
 * of the text plus the number of matches, whatever the dictionary holds.
 */
class KeywordIndex {
  constructor(dictionary) {
    // Parallel arrays rather than objects per node: a trie of a few thousand nodes is
    // built on every cold start and this keeps that off the critical path.
    this.next = [new Map()];
    this.fail = [0];
    this.hit = [null];
    this.suffix = [0];

    for (const [category, words] of Object.entries(dictionary)) {
      for (const word of words) this.#insert(word.toLowerCase(), category);
    }
    this.#link();
  }

  #insert(word, category) {
    let node = 0;
    for (const character of word) {
      let child = this.next[node].get(character);
      if (child === undefined) {
        child = this.next.length;
        this.next.push(new Map());
        this.fail.push(0);
        this.hit.push(null);
        this.suffix.push(0);
        this.next[node].set(character, child);
      }
      node = child;
    }
    // A word already ending here means two categories claim it. The longer word is the
    // more specific one, and identical words are a mistake in the table rather than a
    // case to resolve at runtime.
    if (!this.hit[node] || word.length > this.hit[node].length) {
      this.hit[node] = { category, length: word.length };
    }
  }

  /** Breadth-first failure links, plus a shortcut straight to the next node that matched. */
  #link() {
    const queue = [];
    for (const child of this.next[0].values()) queue.push(child);

    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      for (const [character, child] of this.next[node]) {
        let fallback = this.fail[node];
        while (fallback && !this.next[fallback].has(character)) fallback = this.fail[fallback];
        const target = this.next[fallback].get(character);
        this.fail[child] = target === undefined || target === child ? 0 : target;
        this.suffix[child] = this.hit[this.fail[child]] ? this.fail[child] : this.suffix[this.fail[child]];
        queue.push(child);
      }
    }
  }

  /**
   * The category of the longest keyword in the text.
   *
   * A match only counts on word boundaries, which is what stops "nse" matching inside
   * "expense" and "mall" inside "small". Without that check a table like this quietly
   * categorises everything and is worse than having no table at all.
   */
  find(text) {
    // Punctuation becomes a gap so "booking.com" and "booking com" are the same thing,
    // and so a keyword is never left straddling a dot it cannot see across.
    const haystack = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    let node = 0;
    let best = null;

    for (let i = 0; i < haystack.length; i += 1) {
      const character = haystack[i];
      while (node && !this.next[node].has(character)) node = this.fail[node];
      node = this.next[node].get(character) ?? 0;

      for (let at = this.hit[node] ? node : this.suffix[node]; at; at = this.suffix[at]) {
        const found = this.hit[at];
        if ((!best || found.length > best.length) && bounded(haystack, i - found.length + 1, i)) {
          best = found;
        }
      }
    }
    return best ? best.category : '';
  }
}

function isWordCharacter(character) {
  return character !== undefined && /[a-z0-9]/.test(character);
}

function bounded(text, start, end) {
  return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end + 1]);
}

let index = null;

/** Built on first use, so a screen that never reads a message never pays for the trie. */
function keywords() {
  if (!index) index = new KeywordIndex(VENDORS);
  return index;
}

/* ------------------------------------------------------------------ the key */

// What an acquirer bolts onto the front of a name on its way through the card network.
const ACQUIRER_PREFIX = /^(?:cas\*|wl\s*\*|sq\s*\*|pp\*|paypal\s*\*|upi\/|pos\s+|nfs\*|ecom\s+|imps\/|neft\/)/i;

// What a company puts on the end of its own name. Two branches of one chain should share
// a key, and "ltd" is never the part that distinguishes them.
const CORPORATE_SUFFIX = /\b(?:pvt|private|ltd|limited|llp|inc|corp|corporation|co|company|india|indl|services|service|solutions|technologies|technology|tech|enterprises|enterprise|retail|store|stores|online|payments|payment)\b/g;

/**
 * The stable form of a vendor name.
 *
 * "CAS*CITYFLO", "Cityflo Technologies Pvt Ltd" and "CITYFLO  " have to land on one key
 * or a rule learned from one of them never fires on the others.
 */
export function merchantKey(merchant) {
  return String(merchant || '')
    .toLowerCase()
    .replace(ACQUIRER_PREFIX, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(CORPORATE_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Wordings that carry an amount but did not move any money.
 *
 * These are checked before any rule, because a rule triggers on "debited" and a bank
 * writes "will be debited" three days before it happens. Without this, every autopay
 * reminder is filed as a payment and the same rupee is counted twice: once when the
 * warning arrives and once when the debit does.
 *
 * None of them may be applied blindly, though. See COMPLETED_MOVEMENT below.
 */
const MANDATE_SETUP = new RegExp(
  '\\bmandate (?:has been |is )?(?:registered|created|set ?up|setup|activated|received|approved|accepted|authorized|modified|cancelled|revoked|closed)\\b'
  + '|\\b(?:ach|nach|e-?mandate|mandate|si|standing instruction) (?:registration|creation|setup|cancellation|approval|request|auth|authentication|modification)\\b'
  + '|\\b(?:registered|created|set ?up|setup|activated) (?:ach|nach|e-?mandate|mandate|standing instruction)\\b'
  + '|\\bmandate (?:with|for|of)\\s+.*?\\b(?:registered|created|set ?up|setup|approved|authorized|received|active)\\b',
  'i',
);

const REMINDER = new RegExp(
  '\\b(?:will be|scheduled to be) (?:deducted|debited|credited|auto[- ]?debited|presented|processed)\\b'
  + '|autopay reminder|smartpay scheduled|\\bpre-?debit\\b|\\bmandate (?:pre-?debit|notification|intimation|alert|advice|reminder)\\b'
  + '|\\b(?:scheduled|presented) for (?:debit|deduction|clearing)\\b'
  + '|\\b(?:gentle )?reminder\\b|payment reminder|bill reminder|emi reminder|loan reminder|recharge reminder|expiry reminder|renewal reminder'
  + '|\\b(?:is|are) due\\b|\\bdue on\\b|\\bdue date\\b|minimum amount due|min due|total due|payment due|bill due|overdue|amt due|amount due'
  + '|\\b(?:kindly|please) pay\\b|\\bto be paid by\\b|\\bpay before\\b|\\bpayable by\\b|\\bto avoid late fee\\b|\\bavoid penalty\\b|\\bavoid disconnection\\b'
  + '|\\b(?:bill|e-?bill|invoice|e-statement) (?:generated|is ready|for rs)\\b'
  + '|\\b(?:plan|pack|validity) (?:is )?(?:expiring|expired)\\b|recharge now to continue',
  'i',
);

const SPAM_AND_PROMO = new RegExp(
  '\\b(?:pre-?approved|instant|quick) (?:personal|business|gold|car|home|two[- ]wheeler)?\\s*loan(?:s)?\\b|\\bloan offer\\b|\\bloan approved\\b|\\bavail (?:instant )?loan\\b|\\bcheck loan eligibility\\b|\\bdisbursed in \\d+\\s*(?:min|minute|sec)\\b|\\bget instant cash\\b|\\bget up to rs\\.?\\s*[\\d,]+\\b|\\bloan up to\\b|\\bpre-?qualified\\b|\\bapply for (?:instant |personal )?loan\\b'
  + '|\\b(?:pre-?approved|lifetime free|free|apply for|get your) (?:credit card|card)\\b|\\blimit (?:enhancement|increase|upgrade)\\b|\\bincrease your (?:credit )?limit\\b|\\bupgrade your (?:credit )?card\\b|\\bcredit limit (?:enhanced|increased) to\\b'
  + '|\\b(?:flat|upto|up to) \\d+%\\s*off\\b|\\buse code\\b|\\bpromo code\\b|\\bcoupon code\\b|\\bvoucher code\\b|\\bexclusive offer\\b|\\bspecial offer\\b|\\blimited (?:period )?offer\\b|\\bvalid till\\b|\\bflash sale\\b|\\bmega sale\\b|\\bgreat indian festival\\b|\\bbig billion days\\b|\\bshop now\\b|\\border now\\b|\\bbook now to get\\b|\\bwin (?:cash|rewards|gold|iphone|car|prizes)\\b|\\bscratch card\\b|\\breward points? (?:expiring|will expire|earned|credited)\\b|\\bredeem (?:points|cashback|coupon)\\b|\\bclaim your (?:reward|prize|cashback|bonus)\\b'
  + '|\\b(?:play )?rummy\\b|\\bwin real (?:cash|money)\\b|\\bjackpot\\b|\\bbetting\\b|\\bcasino\\b|\\bearn rs\\.?\\s*\\d+\\s*(?:daily|per day|from home)\\b|\\bpart[- ]time job\\b|\\bwork from home\\b|\\bguaranteed returns\\b|\\btrading calls\\b|\\bstock tips\\b|\\boption tips\\b|\\bsure shot\\b|\\bdouble your money\\b'
  + '|\\bdata (?:pack|balance|quota|limit|usage) (?:is )?(?:exhausted|consumed|over|left)\\b|\\b\\d+%\\s*of (?:daily )?data (?:limit )?consumed\\b|\\bdata alert\\b|\\brecharge (?:now|with rs|pack)\\b|\\bunlimited (?:5g|calls)\\b|\\bcaller ?tune\\b|\\bhello ?tune\\b|\\bcricket pack\\b|\\bextra data\\b'
  + '|\\b(?:update|link|pending|submit|verify) kyc\\b|\\bkyc (?:suspended|expired|pending|verification)\\b|\\blink (?:pan|aadhaar|aadhar)\\b|\\bpan not linked\\b|\\bnetbanking (?:blocked|disabled|locked)\\b|\\blogin (?:alert|notification)\\b|\\bnew login\\b|\\bnew device\\b|\\bpassword (?:changed|reset|updated)\\b|\\bmpin (?:changed|reset|updated)\\b|\\btpin (?:changed|reset|updated)\\b|\\bupi pin (?:changed|reset|updated)\\b|\\bemail (?:updated|registered|changed)\\b|\\bmobile number (?:updated|registered|changed)\\b|\\baddress (?:updated|registered|changed)\\b|\\bnominee (?:updated|registered|added)\\b'
  + '|\\b(?:cheque|check) (?:returned|bounced|dishonou?red)\\b|\\b(?:ecs|nach|mandate|si) (?:returned|bounced|failed|rejected)\\b|\\binsufficient funds\\b|\\bunpaid due to\\b|\\bfailed due to\\b'
  + '|\\bapply now\\b|\\bclick here\\b|\\bt&c apply\\b',
  'i',
);

const NOT_A_TRANSACTION = [
  [/\botp\b|one[- ]time password|verification code|do not share|never share/i, 'otp'],
  [SPAM_AND_PROMO, 'promo'],
  [REMINDER, 'reminder'],
  [MANDATE_SETUP, 'mandate-setup'],
  [/\brequest(?:ed|ing)? (?:money|payment)\b|collect request|has requested (?:rs|inr|₹)|\bmandate request\b/i, 'request'],
  [/\bfailed\b|\bdeclined\b|\breversed\b|could not be processed|unsuccessful|txn reversed/i, 'failed'],
  [/\bavailable balance\b|\bbal(?:ance)? (?:in|as on|enquiry|is)\b|\bavl bal\b/i, 'balance'],
  [/\boffer\b|cashback up to|\bdiscount\b|congratulations|pre-approved loan|win up to|reward points/i, 'promo'],
];

/*
 * Money that moved between the user's own pockets. These describe something that really
 * happened, so they hold whatever else the message says: filing a card bill payment or a
 * wallet top up as income would book every rupee already spent as earnings.
 */
const SELF_TRANSFER = [
  [/credited to your (?:credit )?card|payment of .* was credited|card.*payment received|payment received towards .* card|payment received for your .* card|thank you for payment towards .* card/i, 'card-payment'],
  [/\b(?:paid|payment|debited)\b.*(?:towards|for|to)\s+(?:your\s+)?(?:credit\s+card|sbi\s+card|hdfc\s+card|icici\s+card|axis\s+card|cred|cheq|onecard|amex)\b/i, 'card-payment'],
  [/\b(?:credit\s+card|card\s+bill|cc\s+bill)\s+(?:payment|bill\s+payment|paid|debited)\b/i, 'card-payment'],
  [/info[:\s]*(?:ach\s*d-?\s*|nach-?\s*|cms-?\s*)?(?:cred|cheq|sbi\s*card|cc\s*payment|autopay\s*cc)/i, 'card-payment'],
  // A tag recharge is the user's own money moving from their account to their tag.
  // A meal wallet credit is not: the employer funds it, so it is money arriving. Treating
  // it as a transfer left every wallet spend as an expense with no inflow behind it, and
  // the ledger quietly lost the difference.
  [/fastag.*credited|credited.*fastag|recharge successful/i, 'self-transfer'],
];

/*
 * An amount sitting directly against a past tense verb, which is a movement that has
 * already happened. No incidental word elsewhere in the message may throw that away.
 *
 * This exists because the guards above were doing exactly that. A debit card alert ends
 * "without PIN/OTP", and the word OTP was discarding forty five real spends. A refund
 * mentions "minimum due Rs .00" further along and was read as a bill reminder. A cashback
 * credit opens with "Congratulations" and was read as an advertisement. Every one of
 * those is money that silently never appeared.
 */
const COMPLETED_MOVEMENT = new RegExp(
  '(?:rs\\.?|inr|₹)\\s*\\.?\\s*[\\d,]+(?:\\.\\d+)?\\s*(?:has been\\s+|was\\s+)?'
  + '(?:spent|debited|credited|deducted|withdrawn|paid|deposited)\\b'
  + '|\\b(?:spent|debited|credited|deducted|withdrawn|paid|deposited)[\\s:]+'
  + '(?:of\\s+|from\\s+|at\\s+|on\\s+|via\\s+|for\\s+|by\\s+|on\\s+\\d{1,2}[-/](?:[A-Za-z]{3}|\\d{1,2})[-/]\\d{2,4}\\s+(?:by|for|of|with)\\s+)?(?:rs\\.?|inr|₹)?\\s*\\.?\\s*[\\d,]',
  'i',
);

// What puts a movement in the future or in somebody else's hands, and so separates
// "Rs.500 was debited" from "Rs.500 will be debited".
const HEDGED = new RegExp(
  '\\bwill be\\b|\\bis due\\b|\\bdue on\\b|\\bdue date\\b|\\brequest(?:ed|ing)?\\b'
  + '|reminder|scheduled|will expire|\\bpre-?debit\\b|intimation'
  + '|\\bmandate (?:pre-?debit|notification|intimation|alert|advice|reminder|registration|creation|setup|request)\\b'
  + '|\\b(?:registered|created|set ?up|setup|activated) (?:ach|nach|e-?mandate|mandate)\\b'
  + '|\\b(?:scheduled|presented) for (?:debit|deduction|clearing)\\b'
  + '|\\b(?:statement|e-?statement) (?:generated|is generated|ready|for card)\\b|\\btotal (?:amt|amount)? due\\b|\\bmin(?:imum)? (?:amt|amount)? due\\b'
  + '|upcoming|payable by|pay before|kindly pay|please pay|to avoid'
  + '|\\bapply now\\b|\\bclick here\\b|\\bcheck loan eligibility\\b|\\bpre-?approved (?:loan|credit card|card)\\b|\\binstant loan\\b',
  'i',
);

/** Why this message is not a transaction, or an empty string when it is one. */
export function notATransaction(text) {
  // Ignore ANY SMS with OTP / verification code first (excluding safety notifications like "without PIN/OTP")
  if ((/\botp\b|one[- ]time password|verification code|do not share|never share/i.test(text))
      && !(/\bwithout (?:pin\/)?otp\b|\bno (?:pin\/)?otp\b/i.test(text))) {
    return 'otp';
  }
  for (const [pattern, reason] of SELF_TRANSFER) {
    if (pattern.test(text)) return reason;
  }

  // Failed transactions should always report 'failed'
  if (/\bfailed\b|\bdeclined\b|\breversed\b|could not be processed|unsuccessful|txn reversed/i.test(text)) {
    return 'failed';
  }

  // Something that plainly already happened is a transaction, whatever else it mentions.
  if (COMPLETED_MOVEMENT.test(text) && !HEDGED.test(text)) return '';

  // Setup notifications, reminders, spam and promos should never be recorded as completed transactions
  if (MANDATE_SETUP.test(text)) return 'mandate-setup';
  if (REMINDER.test(text)) return 'reminder';
  if (SPAM_AND_PROMO.test(text)) return 'promo';

  for (const [pattern, reason] of NOT_A_TRANSACTION) {
    if (pattern.test(text)) return reason;
  }
  return '';
}

/* ------------------------------------------------------- merchant extraction */

/*
 * The slot a merchant sits in. Issuers word the rest of the message differently but they
 * all name the counterparty in one of these few shapes, which is why this is a parsing
 * problem and not a learning one.
 */
const MERCHANT_PATTERNS = [
  /\bat\s+([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s+(?:on|dt\.?|avl|bal|using|via|ref|refno|rrn|txn|for|through)\b/i,
  /\bupi\/([\w .@\-]{2,30}?)\s+(?:on|ref|txn)\b/i,
  /\b(?:vpa|to vpa)\s+([^\s.,;]+)/i,
  /\bto\s+([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s+on\s+\d/i,
  /\b(?:paid|transferred|sent|trf)\s+to\s+([A-Za-z0-9][\w .&*'()\-/]{1,44}?)(?:\s+(?:on|dt\.?|avl|bal|using|via|ref|refno|rrn|txn|for|through)\b|[.,;]|$)/i,
  /\btowards\s+(?:ach\s*[dc*:\s/-]*|nach[*:\s/-]*|cms[*:\s/-]*|ecs[*:\s/-]*|mandate[*:\s/-]*|si[*:\s/-]*)?([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s*(?:umrn|ref|[.,;]|$)/i,
  /\binfo[:\s]*(?:ach\s*[dc*:\s/-]*|nach[*:\s/-]*|cms[*:\s/-]*|ecs[*:\s/-]*|mandate[*:\s/-]*|upi\/)?([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s*[.;-]/i,
  /\bat\s+([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s*[.;]/i,
  /\b(?:biller|merchant|beneficiary|party)[:\s]+([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s*[.;\n\r]/i,
  /\bfrom\s+([A-Za-z0-9][\w .&*'()\-/]{1,44}?)\s+(?:on|dt\.?|avl|bal|using|via)\b/i,
  /\bfor\s+(?:ach\s*[dc*:\s/-]*|nach[*:\s/-]*|cms[*:\s/-]*|ecs[*:\s/-]*|mandate[*:\s/-]*)?([A-Za-z0-9][\w .&*'()\-/]{1,44}?)(?:\s+(?:on|dt\.?|avl|bal|using|via|ref|refno|rrn|txn)\b|[.,;]|$)/i,
];

/*
 * What lands in the merchant slot when the sentence was not naming a vendor at all.
 *
 * "Payment of INR 2,472 was credited to your Card xx5157" fills the slot with "your card
 * xx5157", and an account number is not a shop. Left alone these become merchant keys,
 * and a key built from a card number is a rule that can never match anything else.
 */
const NOT_A_MERCHANT = new RegExp(
  // Nothing trades under a name beginning "your". That opening belongs to the bank
  // talking about you, as in "towards your last month spends".
  '^(?:your|the|my)\\b'
  + '|^other services\\b|^customer care\\b|^helpline\\b|^toll[- ]free\\b'
  + '|^(?:your |the |a |my )?(?:a/c|ac|acct|account|card|credit card|debit card|bank|wallet'
  + '|upi|vpa|ref|txn|payment|amount|balance|limit'
  + '|ach|nach|ecs|cms|mandate|standing instruction|si|neft|rtgs|imps|enach|e-nach)\\b'
  + '|^(?:rs|inr|usd|eur|gbp|₹)\\b'
  + '|^(?:hdfc|icici|sbi|axis|kotak|au bank|au credit|dcb|idfc|indusind|yes bank|pnb|canara|federal|rbl|bob|boi|union|iob|uco|scb|stanchart|standard chartered|citi|citibank|hsbc|dbs|deutsche|barclays|equitas|ujjivan|bandhan|sib|south indian|kvb|karur vysya|cub|city union|karnataka|psb|punjab & sind|bom|bank of maharashtra|cbi|central bank|indian bank|airtel payments|ippb|fino|jio payments)(?:\\s+bank)?(?:\\s+(?:a/c|ac|acct|account|card|credit card|debit card))?\\s*$',
  'i',
);

/** The counterparty named in a message, or an empty string when it names none. */
export function extractMerchant(body) {
  const text = String(body || '');
  for (const pattern of MERCHANT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    let found = match[1].trim().replace(/\s+/g, ' ').replace(/^[.,;:\-\s]+|[.,;:\-\s]+$/g, '');
    found = found.replace(/[*\/].*$/, '').trim();
    found = found.replace(/(?:DIV|DIVIDEND)\d*.*$/i, '').trim();
    // Keep looking: a later pattern may still find the real counterparty.
    if (!found || NOT_A_MERCHANT.test(found) || !/[a-z]/i.test(found)) continue;
    return found;
  }
  return '';
}

/**
 * The category the shipped dictionary would give this message.
 *
 * The merchant decides it. The body is the fallback and the weaker signal, because a
 * bank's boilerplate is full of words that look like categories and are not.
 */
export function categoryForMerchant(merchant, body = '') {
  if (merchant) {
    const found = keywords().find(merchant);
    if (found) return found;
  }
  const bodyText = String(body || '');
  if (/\b(?:dividend|dividends|interim dividend|final dividend)\b|[*:\s/-][a-z0-9_]*div\d*[*:\s/.-]/i.test(bodyText)) {
    return 'Interest & Dividends';
  }
  return bodyText ? keywords().find(bodyText) : '';
}
