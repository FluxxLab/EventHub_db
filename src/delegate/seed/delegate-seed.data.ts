/**
 * Delegates for a directory that has to look lived-in before it is.
 *
 * `generate` draws from two sources. First, REAL_ROSTER below - actual GIS-26
 * registrants, name and organisation only, exhausted before anyone is
 * invented (see the note on REAL_ROSTER for what that trade-off costs).
 * Once it runs out, the rest are fully synthetic: names assembled per region
 * so first name and surname agree - a Yoruba first name with a Kanuri
 * surname is the kind of thing a Nigerian reader notices at once - with a
 * title, tier, tracks and interests invented to match. An organisation is
 * still picked internally, to weight the title and tier realistically, but
 * never shown: it is a specific, checkable claim, and organisation is left
 * blank on every row for that reason - real registrant or invented alike.
 *
 * What a delegate sees of another delegate is name, title and an avatar -
 * so those are the fields that have to read as real. Country is left unset,
 * like organisation: a real self-registered delegate has none either, and a
 * seeded row must not carry a field the real ones do not. Every delegate
 * here is Nigerian, on a Nigerian public mail domain - the mix a real gender
 * summit in Abuja actually draws.
 *
 * Nothing marks a row as a placeholder to anyone reading the directory or an
 * export - what keeps it honest lives on the account instead:
 * `hasChosenPassword` is false, so it cannot receive a reset email, and the
 * password hash is of a secret nobody holds, so it cannot be signed into
 * even if it could.
 */
import { randomInt } from 'crypto';
import { AccessTier } from '../entities/delegate.entity';

type Region = {
  first: { f: string[]; m: string[] };
  last: string[];
  weight: number;
  /** Honorifics a reader would accept in front of these names. */
  honorifics?: { f: string[]; m: string[] };
};

// ---------------------------------------------------------------- names
const REGIONS: Record<string, Region> = {
  yoruba: {
    weight: 30,
    honorifics: {
      f: ['Dr.', 'Mrs.', 'Ms.', 'Alhaja', 'Barr.', 'Prof.'],
      m: ['Dr.', 'Mr.', 'Alhaji', 'Engr.', 'Barr.', 'Prof.'],
    },
    first: {
      f: [
        'Adebisi',
        'Adeola',
        'Aduke',
        'Bolanle',
        'Bukola',
        'Damilola',
        'Folake',
        'Funmilayo',
        'Ibironke',
        'Kehinde',
        'Modupe',
        'Morenike',
        'Olabisi',
        'Oluwaseun',
        'Omolara',
        'Opeyemi',
        'Ronke',
        'Simisola',
        'Temitope',
        'Titilayo',
        'Yetunde',
        'Yewande',
        'Abisola',
        'Feyisara',
        'Iyabo',
      ],
      m: [
        'Adebayo',
        'Adekunle',
        'Ayodele',
        'Babatunde',
        'Bamidele',
        'Damilare',
        'Femi',
        'Gbenga',
        'Kayode',
        'Kolawole',
        'Lanre',
        'Olamide',
        'Olusegun',
        'Oluwatobi',
        'Rotimi',
        'Seyi',
        'Taiwo',
        'Tunde',
        'Wale',
        'Yinka',
        'Adewale',
        'Akinyemi',
        'Dapo',
        'Jide',
        'Niyi',
      ],
    },
    last: [
      'Adeyemi',
      'Adebayo',
      'Ogunleye',
      'Bankole',
      'Oyelaran',
      'Akinola',
      'Fashola',
      'Balogun',
      'Oyediran',
      'Olanrewaju',
      'Adegoke',
      'Ojo',
      'Ajayi',
      'Salami',
      'Odunsi',
      'Ogundipe',
      'Shittu',
      'Lawal',
      'Oyebode',
      'Fakunle',
      'Adesanya',
      'Abiodun',
      'Olaniyan',
      'Ogunbiyi',
      'Kolade',
    ],
  },
  igbo: {
    weight: 25,
    first: {
      f: [
        'Adaeze',
        'Amaka',
        'Chiamaka',
        'Chidinma',
        'Chinelo',
        'Chioma',
        'Ebele',
        'Ifeoma',
        'Ijeoma',
        'Ngozi',
        'Nkechi',
        'Nneka',
        'Obiageli',
        'Oluchi',
        'Onyinye',
        'Uchenna',
        'Ugochi',
        'Adanna',
        'Chinwe',
        'Ogechi',
        'Somtochukwu',
        'Kosisochukwu',
      ],
      m: [
        'Chibuzo',
        'Chidi',
        'Chukwuemeka',
        'Emeka',
        'Ikenna',
        'Kelechi',
        'Nnamdi',
        'Obinna',
        'Okechukwu',
        'Onyekachi',
        'Tobechukwu',
        'Uche',
        'Chukwudi',
        'Ebuka',
        'Ifeanyi',
        'Kenechukwu',
        'Nonso',
        'Obiora',
        'Somto',
        'Zik',
      ],
    },
    last: [
      'Okafor',
      'Okonkwo',
      'Nwosu',
      'Eze',
      'Okoro',
      'Nwachukwu',
      'Obi',
      'Anyanwu',
      'Chukwu',
      'Igwe',
      'Okeke',
      'Nnaji',
      'Ezeh',
      'Onwuka',
      'Udeh',
      'Madu',
      'Agu',
      'Ibe',
      'Ekwueme',
      'Onyeka',
      'Nwankwo',
      'Uzoma',
      'Okolie',
      'Ugwu',
      'Achebe',
    ],
  },
  hausa: {
    weight: 25,
    honorifics: {
      f: ['Dr.', 'Hajiya', 'Malama', 'Barr.', 'Prof.'],
      m: ['Dr.', 'Alhaji', 'Mallam', 'Engr.', 'Barr.', 'Prof.'],
    },
    first: {
      f: [
        'Aisha',
        'Amina',
        'Fatima',
        'Hadiza',
        'Halima',
        'Hauwa',
        'Jamila',
        'Khadija',
        'Maryam',
        'Rukayya',
        'Safiya',
        'Sadiya',
        'Zainab',
        'Bilkisu',
        'Habiba',
        'Nafisa',
        'Rahama',
        'Ummi',
        'Zahra',
        "Asma'u",
      ],
      m: [
        'Abdullahi',
        'Abubakar',
        'Aliyu',
        'Bashir',
        'Ibrahim',
        'Isah',
        'Kabiru',
        'Musa',
        'Nasiru',
        'Sani',
        'Shehu',
        'Umar',
        'Usman',
        'Yusuf',
        'Bala',
        'Garba',
        'Hamza',
        'Idris',
        'Mustapha',
        'Salisu',
      ],
    },
    last: [
      'Abdullahi',
      'Bello',
      'Danjuma',
      'Garba',
      'Ibrahim',
      'Lawal',
      'Mohammed',
      'Musa',
      'Sani',
      'Shehu',
      'Suleiman',
      'Yakubu',
      'Yusuf',
      'Adamu',
      'Aliyu',
      'Dantata',
      'Gambo',
      'Hassan',
      'Jibril',
      'Kabir',
      'Maikudi',
      'Tanko',
      'Umar',
      'Wada',
      'Zubairu',
    ],
  },
  edo: {
    weight: 6,
    first: {
      f: [
        'Osarumen',
        'Eghosa',
        'Osaretin',
        'Ivie',
        'Uyi',
        'Efe',
        'Esohe',
        'Osasere',
        'Adesuwa',
        'Itohan',
      ],
      m: [
        'Osagie',
        'Osaze',
        'Ehimen',
        'Ogbeide',
        'Nosa',
        'Ehis',
        'Aiwerioba',
        'Osahon',
        'Omoruyi',
        'Etinosa',
      ],
    },
    last: [
      'Osagie',
      'Igbinedion',
      'Omoregie',
      'Ehigiator',
      'Aigbe',
      'Idahosa',
      'Osemwegie',
      'Eweka',
      'Oviasu',
      'Obaseki',
      'Iyayi',
      'Airhihenbuwa',
    ],
  },
  efik: {
    weight: 5,
    first: {
      f: [
        'Arit',
        'Ekaette',
        'Ime',
        'Iniobong',
        'Mfon',
        'Nsikak',
        'Uduak',
        'Idara',
        'Ekemini',
        'Abasiama',
      ],
      m: [
        'Aniekan',
        'Edidiong',
        'Effiong',
        'Ekpenyong',
        'Emem',
        'Etim',
        'Okon',
        'Ubong',
        'Bassey',
        'Enobong',
      ],
    },
    last: [
      'Bassey',
      'Effiong',
      'Ekpo',
      'Etim',
      'Essien',
      'Okon',
      'Udoh',
      'Akpan',
      'Umoh',
      'Ekanem',
      'Inyang',
      'Edet',
    ],
  },
  tiv: {
    weight: 4,
    first: {
      f: [
        'Doosuur',
        'Msurshima',
        'Kwaghdoo',
        'Ngodoo',
        'Mimidoo',
        'Terhemen',
        'Sewuese',
        'Hembadoon',
      ],
      m: [
        'Terfa',
        'Iorwuese',
        'Tersoo',
        'Aondona',
        'Terkimbi',
        'Iorfa',
        'Sesugh',
        'Mnguter',
      ],
    },
    last: [
      'Iorliam',
      'Akume',
      'Gemade',
      'Ayua',
      'Tyokighir',
      'Unongo',
      'Ikyaa',
      'Suswam',
      'Ortom',
      'Agbo',
    ],
  },
  ijaw: {
    weight: 3,
    first: {
      f: ['Preye', 'Ebiere', 'Tamara', 'Diepreye', 'Ebiye', 'Timipre', 'Boma'],
      m: [
        'Tamuno',
        'Ebi',
        'Timi',
        'Ayebatari',
        'Perekeme',
        'Kemepade',
        'Ebipade',
      ],
    },
    last: [
      'Alamieyeseigha',
      'Dickson',
      'Jonathan',
      'Diri',
      'Sylva',
      'Okara',
      'Ogoni',
      'Amaebi',
      'Owei',
      'Ikiba',
    ],
  },
  kanuri: {
    weight: 2,
    honorifics: {
      f: ['Dr.', 'Hajiya', 'Barr.'],
      m: ['Dr.', 'Alhaji', 'Engr.', 'Barr.'],
    },
    first: {
      f: ['Falmata', 'Yagana', 'Fanna', 'Amina', 'Hadiza', 'Zara'],
      m: ['Kyari', 'Bukar', 'Modu', 'Grema', 'Kolo', 'Baba'],
    },
    last: [
      'Shettima',
      'Kyari',
      'Bukar',
      'Zulum',
      'Kaigama',
      'Goni',
      'Mustapha',
      'Mele',
    ],
  },
};

// ---------------------------------------------------------------- organisations and titles
const ORGANISATIONS: {
  name: string;
  titles: string[];
  tier?: AccessTier;
  country?: string;
}[] = [
  {
    name: 'Federal Ministry of Women Affairs and Social Development',
    titles: [
      'Deputy Director, Gender Affairs',
      'Assistant Director, Women Development',
      'Programme Officer',
      'Chief Social Welfare Officer',
    ],
  },
  {
    name: 'Federal Ministry of Health and Social Welfare',
    titles: [
      'Assistant Director, Family Health',
      'Programme Officer, Nutrition',
      'Medical Officer',
      'Health Planning Analyst',
    ],
  },
  {
    name: 'Federal Ministry of Education',
    titles: [
      'Deputy Director, Basic Education',
      'Senior Education Officer',
      'Gender Desk Officer',
    ],
  },
  {
    name: 'National Primary Health Care Development Agency',
    titles: [
      'State Immunisation Officer',
      'Monitoring and Evaluation Officer',
      'Community Health Coordinator',
    ],
  },
  {
    name: 'Kaduna State Ministry of Health',
    titles: [
      'Director, Public Health',
      'Reproductive Health Coordinator',
      'Programme Manager',
    ],
  },
  {
    name: 'Kano State Ministry of Women Affairs',
    titles: [
      'Director, Women Development',
      'Gender Officer',
      'Social Welfare Officer',
    ],
  },
  {
    name: 'Lagos State Ministry of Women Affairs and Poverty Alleviation',
    titles: [
      'Head, Gender Unit',
      'Senior Programme Officer',
      'Empowerment Coordinator',
    ],
  },
  {
    name: 'Borno State Primary Health Care Development Agency',
    titles: ['Deputy Director', 'Zonal Coordinator', 'Data Officer'],
  },
  {
    name: 'Nasarawa State Ministry of Education',
    titles: [
      'Director, Girl-Child Education',
      'Education Secretary',
      'Planning Officer',
    ],
  },
  {
    name: 'Bayero University Kano',
    titles: [
      'Senior Lecturer, Centre for Gender Studies',
      'Research Fellow',
      'Lecturer, Economics',
    ],
  },
  {
    name: 'University of Ibadan',
    titles: [
      'Senior Lecturer, Economics',
      'Research Fellow',
      'Postgraduate Researcher',
      'Lecturer, Sociology',
    ],
  },
  {
    name: 'University of Lagos',
    titles: ['Senior Lecturer', 'Research Associate', 'Doctoral Researcher'],
  },
  {
    name: 'University of Maiduguri',
    titles: ['Lecturer, Public Health', 'Research Fellow', 'Senior Lecturer'],
  },
  {
    name: 'Ahmadu Bello University',
    titles: [
      'Senior Lecturer',
      'Research Fellow',
      'Lecturer, Community Medicine',
    ],
  },
  {
    name: 'University of Nigeria, Nsukka',
    titles: ['Senior Lecturer', 'Research Fellow', 'Lecturer, Economics'],
  },
  {
    name: 'Nile University of Nigeria',
    titles: ['Lecturer, Economics', 'Research Associate'],
  },
  { name: 'Veritas University Abuja', titles: ['Lecturer', 'Research Fellow'] },
  {
    name: 'Small Scale Women Farmers Organisation in Nigeria (SWOFON)',
    titles: ['State Coordinator', 'Programme Officer', 'Member'],
  },
  {
    name: 'Women in Successful Careers (WISCAR)',
    titles: ['Programme Manager', 'Mentorship Lead', 'Member'],
  },
  {
    name: 'Centre for Girls Education',
    titles: ['Programme Officer', 'Field Coordinator', 'Team Lead'],
  },
  {
    name: 'Education as a Vaccine',
    titles: ['Programme Officer', 'Advocacy Lead', 'Communications Officer'],
  },
  {
    name: 'Invictus Africa',
    titles: ['Programme Manager', 'Research Officer', 'Advocacy Officer'],
  },
  {
    name: 'TechHer NG',
    titles: ['Programme Lead', 'Community Manager', 'Digital Skills Trainer'],
  },
  {
    name: 'She Forum Africa',
    titles: ['Programme Officer', 'Communications Lead', 'Member'],
  },
  {
    name: 'Girl Effect Nigeria',
    titles: ['Programme Officer', 'Research Associate', 'Content Lead'],
  },
  {
    name: 'Society for Family Health',
    titles: [
      'Programme Manager',
      'Monitoring and Evaluation Officer',
      'State Coordinator',
    ],
  },
  {
    name: 'Plan International Nigeria',
    titles: [
      'Gender Equality Specialist',
      'Programme Officer',
      'Country Programme Advisor',
    ],
  },
  {
    name: 'Save the Children Nigeria',
    titles: [
      'Child Protection Advisor',
      'Programme Officer',
      'Advocacy and Campaigns Officer',
    ],
  },
  {
    name: 'UN Women Nigeria',
    titles: [
      'Programme Specialist',
      'Programme Analyst',
      'Communications Officer',
    ],
  },
  {
    name: 'UNICEF Nigeria',
    titles: [
      'Gender and Development Officer',
      'Health Specialist',
      'Programme Officer',
    ],
  },
  {
    name: 'UNDP Nigeria',
    titles: ['Programme Analyst', 'Gender Specialist', 'Project Coordinator'],
  },
  {
    name: 'World Bank Nigeria',
    titles: [
      'Social Development Specialist',
      'Operations Officer',
      'Consultant',
    ],
  },
  {
    name: 'Gates Foundation, Nigeria Country Office',
    titles: [
      'Programme Officer',
      'Senior Programme Officer',
      'Associate Programme Officer',
    ],
  },
  {
    name: 'MacArthur Foundation Nigeria',
    titles: ['Programme Officer', 'Grants Manager'],
  },
  {
    name: 'Ford Foundation West Africa',
    titles: ['Programme Officer', 'Programme Associate'],
  },
  {
    name: 'Clinton Health Access Initiative Nigeria',
    titles: ['Programme Manager', 'Associate', 'Senior Analyst'],
  },
  {
    name: 'Pathfinder International Nigeria',
    titles: ['Programme Manager', 'Technical Advisor', 'State Team Lead'],
  },
  {
    name: 'Innovations for Poverty Action Nigeria',
    titles: ['Research Manager', 'Research Associate', 'Field Manager'],
  },
  {
    name: 'Nigerian Economic Summit Group',
    titles: ['Policy Analyst', 'Research Associate', 'Programme Manager'],
  },
  {
    name: "Nigeria Governors' Forum Secretariat",
    titles: ['Programme Officer', 'Health Desk Officer', 'Policy Analyst'],
  },
  {
    name: "Nigeria Governors' Spouses Forum",
    titles: ['Programme Officer', 'Coordinator'],
  },
  {
    name: 'Bank of Industry',
    titles: [
      'Deputy Manager',
      'Relationship Manager',
      'Assistant Manager, Gender Business',
    ],
  },
  {
    name: 'Sterling Bank',
    titles: ['Head, Agribusiness', 'Relationship Manager', 'Product Manager'],
  },
  {
    name: 'Access Bank',
    titles: [
      'Group Head, W Initiative',
      'Relationship Manager',
      'Product Manager',
    ],
  },
  {
    name: 'NIRSAL Plc',
    titles: ['Finance Facilitation Officer', 'Regional Manager', 'Analyst'],
  },
  { name: 'Sabou Capital', titles: ['Investment Associate', 'Analyst'] },
  {
    name: 'HerVest',
    titles: ['Head of Growth', 'Product Manager', 'Community Manager'],
  },
  {
    name: 'Sahel Consulting',
    titles: ['Consultant', 'Senior Consultant', 'Analyst'],
  },
  {
    name: 'TechnoServe Nigeria',
    titles: [
      'Programme Manager',
      'Business Advisor',
      'Senior Business Advisor',
    ],
  },
  {
    name: 'Corus International',
    titles: ['Public Sector Engagement Specialist', 'Programme Officer'],
  },
  {
    name: 'Channels Television',
    titles: ['Correspondent', 'Producer', 'Reporter'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'Arise News',
    titles: ['Correspondent', 'Reporter', 'Producer'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'Premium Times',
    titles: ['Senior Reporter', 'Development Correspondent', 'Editor'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'The Guardian Nigeria',
    titles: ['Correspondent', 'Features Writer'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'Daily Trust',
    titles: ['Correspondent', 'Senior Reporter'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'TVC News',
    titles: ['Reporter', 'Producer'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'News Central Television',
    titles: ['Correspondent', 'Producer'],
    tier: AccessTier.PRESS,
  },
  {
    name: 'FCDO Nigeria',
    titles: ['Development Advisor', 'Programme Manager', 'Policy Officer'],
  },
  {
    name: 'High Commission of Canada in Nigeria',
    titles: ['Development Officer', 'Programme Manager'],
  },
];

// the same five thematic tracks the app offers at onboarding
const TRACKS = ['digital', 'economic', 'gbv', 'health', 'security'];
const INTERESTS = [
  'Keynotes & Plenaries',
  'Panel Discussions',
  'Masterclasses & Workshops',
  'Policy Roundtables',
  'Research Presentations',
  'Exhibition Booths',
  'Innovation Pitches',
  'Product Demos',
  'Toolkits & Playbooks',
  'Poster Displays',
  'Partner Matchmaking',
  'Peer Networking',
  'VIP Receptions',
  'Sector Meetups',
  'Investor & Donor Meetings',
  'PPP Coalitions',
  'Sponsorship & Co-Hosting',
  'Hackathon Demos',
  'Design Sprints',
  'Award Ceremonies',
  'Media Briefings',
  'Storytelling Showcases',
];
const HONORIFICS_F = ['Dr.', 'Mrs.', 'Ms.', 'Barr.', 'Prof.'];
const HONORIFICS_M = ['Dr.', 'Mr.', 'Engr.', 'Barr.', 'Prof.'];

// ---------------------------------------------------------------- generation
const pick = <T>(xs: readonly T[]): T => xs[randomInt(xs.length)];
const sample = <T>(xs: readonly T[], n: number): T[] => {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length)
    out.push(pool.splice(randomInt(pool.length), 1)[0]);
  return out;
};
const weightedRegion = (): Region => {
  const total = Object.values(REGIONS).reduce((s, r) => s + r.weight, 0);
  let roll = randomInt(total);
  for (const r of Object.values(REGIONS)) {
    if ((roll -= r.weight) < 0) return r;
  }
  return REGIONS.yoruba;
};
const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase();

/**
 * Actual GIS-26 registrants, name and organisation only - the id column the
 * registration export carried is dropped, since it means nothing here and
 * would only invite treating these rows as more official than they are.
 * The organisation is kept here even though `generate` never displays it -
 * it still feeds tier weighting - but it is real data from the export, not
 * invented, unlike everything else `generate` fills in below.
 *
 * These are real people, so nothing about them is invented beyond what
 * `generate` has to invent for every row (an email, a tier, tracks and
 * interests) - no job title is fabricated for them, unlike the synthetic
 * pool below, because we were not given one and a specific title is a
 * specific claim about a real person.
 *
 * The gap this leaves: the email is fabricated, so if one of these people
 * later self-registers with their real address, the two accounts will not
 * match and both will exist side by side. There is no clean fix for that
 * short of an invite-code registration list keyed to their real email, which
 * this data does not have. Before the directory goes in front of delegates,
 * either reconcile these rows against real self-registrations by hand or
 * delete them - they are exactly the rows with `hasChosenPassword` false and
 * a name on this list.
 */
const REAL_ROSTER: { name: string; organisation?: string }[] = [
  { name: 'Maryam Abdallah', organisation: 'Udama Initiative for Women' },
  { name: 'Michael Akanji', organisation: 'Heartland Alliance' },
  { name: 'Emmanuella Alli' },
  {
    name: 'Yetunde Bawa-Allah Saliu',
    organisation: 'Eco-Clean Active Initiatives',
  },
  { name: 'Halleluia Jeremy Ekele', organisation: 'Virexa Diagnostics' },
  { name: 'Jamila Abubakar', organisation: 'Adijocy Global Service Ltd' },
  {
    name: 'Blessed Hamed-Musa',
    organisation: "Women's Technology Empowerment Centre",
  },
  {
    name: 'Safiyya Lawal Danmusa',
    organisation: 'Centre for Gender Studies, FUDMA',
  },
  { name: 'Cynthia Olise', organisation: 'Manufacturing' },
  { name: 'Obiajuru Gloria Olise', organisation: 'FIWON' },
  { name: 'Olivia Olise', organisation: 'Jade Olise Foundation' },
  { name: 'Judith Olise', organisation: 'Jade Olise Foundation' },
  { name: 'Gabriel Onyebuolise', organisation: 'Chanja Datti Limited' },
  { name: 'Maryam Abdulkarim', organisation: 'Ecosmart AI and Innovation Ltd' },
  { name: 'Maryam Abdullahi', organisation: 'Radio Nigeria' },
  {
    name: 'Farida Abdulkareem',
    organisation: 'Raw Materials Research and Development Council',
  },
  { name: 'Fatima Abdulkareem Buba', organisation: 'NIRSAL' },
  {
    name: 'Fatimah Abubakar',
    organisation: "Udama Initiative for Women's Empowerment",
  },
  {
    name: 'Haleemah Abubakar',
    organisation: 'Udama Women Empowerment Initiative',
  },
  {
    name: 'Fauziya Abubakar Kure',
    organisation: 'Women Advocating for Gender Solutions and Mentorship',
  },
  { name: 'Simisolaoluwa Aladeitan' },
  { name: 'Simi John Dalyop', organisation: 'Bincike International' },
  { name: 'Nafisat Kasim' },
  {
    name: 'Miranda Nkasi',
    organisation:
      'The Minkasi Rural Development for Women and Youth Initiative',
  },
  { name: 'Firdaus Abdullahi', organisation: 'Girls In Diplomacy' },
  { name: 'Sakeenah Ajanah', organisation: 'Alfijr Foundation' },
  { name: 'Janet Alabede', organisation: 'Ability Centre' },
  { name: 'Grace Agbogidi', organisation: 'Teach Extra Initiative' },
  { name: 'Joy Agida', organisation: 'National Hospital' },
  {
    name: 'Gideon Dunioh',
    organisation: 'Veritas University Alumni Association',
  },
  {
    name: 'Isah Gidado',
    organisation: 'Kauna Human Capital Development Initiative',
  },
  { name: 'Esele Abhulimen', organisation: 'National Assembly' },
  {
    name: 'Oluwaseyi Adeolowu',
    organisation:
      'Women’s Initiative for Stability Health and Empowerment (WISE-H)',
  },
  { name: 'Mujidat Agbabiaka', organisation: 'Nigerian Women Trust Fund' },
  {
    name: 'Osayuwamen Aladeselu',
    organisation: 'The Diamond Circle and Synergy Ltd',
  },
  {
    name: 'Alex Amiolemen',
    organisation:
      'Initiative for Gender Equality and Sexual Reproductive Health',
  },
  {
    name: 'Adebimpe Abodunde',
    organisation: 'Centre for Journalism Innovation and Development',
  },
  { name: 'Mubaraq Adebimpe', organisation: 'Atiba University' },
  {
    name: 'Adebimpe Adegoke',
    organisation: 'Edupsyche Special Educational Consult',
  },
  { name: 'Ibim Harry', organisation: 'DLV' },
  {
    name: 'Chiabi Martin Sam',
    organisation: 'Grace Charitable and Rehabilitation Organization (GRACARO)',
  },
  { name: 'Miracle Eze', organisation: 'Federal Ministry of Health' },
  {
    name: 'Mary-Jane Ukaegbu',
    organisation: 'Resource Conservation Development Initiative',
  },
  { name: 'Mabum Kwasen', organisation: 'Public & Private Development Centre' },
  { name: 'Saratu Abel Buba', organisation: 'NERIVA Initiative' },
  { name: 'Riana Adams Sabadash', organisation: 'Femme Au Pluriel' },
  { name: 'George Asabor', organisation: 'AXA Mansard Insurance Plc' },
  { name: 'Mohammed Sarki Bello', organisation: 'Nigeria for Women Project' },
  {
    name: 'Sarah Bentu',
    organisation: 'Ecosystem Coordination Strategic Unit (ECSU-ID4D)',
  },
  { name: 'Ibrahim Abdulmumin' },
  { name: 'Ibrahim Adebayo', organisation: 'Native Bridge Empire' },
  {
    name: 'Moshood Adeyemo',
    organisation: 'God Chasers Christian Resources Center',
  },
  { name: 'Basirah Balogun', organisation: "Sirah's Nigeria Limited" },
  {
    name: 'Yasir Muhammad Aliyu',
    organisation: 'Foundation for Youth Awakening and Empowerment (FOYAE)',
  },
  { name: 'Nusirat Tijjani', organisation: 'Women Peace Revival' },
  {
    name: 'Nasir Umar Kassim',
    organisation: 'Federal Ministry of Health and Social Welfare',
  },
  {
    name: 'Zainab Ajimi Badu',
    organisation: 'Future Resilience and Development Foundation',
  },
  { name: 'Joycelyn Bijimi', organisation: 'FACT' },
  {
    name: 'Iko-Ojo Charity Ejima',
    organisation: 'IMH Shelter & Investment Ltd',
  },
  { name: 'Jennifer Hilejime', organisation: 'Execution Edge Limited' },
  { name: 'Dorcas Jim', organisation: 'French with Madame Anthonia' },
  { name: 'Goodness James', organisation: 'Project 29 Foundation' },
  { name: 'Oluwakemi Joseph' },
  { name: 'Sherifat Adegunlola', organisation: 'Edge Social Impact Partners' },
  { name: 'Selimat Olayemi Akinwale', organisation: 'Freelancing' },
  { name: 'Halima Alhassan', organisation: 'Federal Ministry of Education' },
  {
    name: 'Happiness Echeya',
    organisation: 'South Atlantic Petroleum Medical Centre',
  },
  { name: 'Happiness Nehemiah', organisation: 'Pad-Up Creation Limited' },
  {
    name: 'Abayomi Tunji Olatunji',
    organisation: 'Entrepreneurship Development and Support Initiative',
  },
  { name: 'Sylvanus Udoenoh', organisation: 'CREAP Africa Initiative' },
];

export interface SeedDelegate {
  name: string;
  email: string;
  /** null, not '', for a real registrant - an unset field stays unset. */
  title: string | null;
  /** Always null - see the comment where this is set below. */
  organisation: string | null;
  /** Always null - a real self-registered delegate has none either. */
  country: string | null;
  accessTier: AccessTier;
  tracks: string[];
  interests: string[];
}

/**
 * `generate` is a pure function with no memory between calls, and the
 * trickle service and the CLI script are separate process runs (and a
 * restart of either is a fresh one too) - so "exhaust the roster before
 * inventing anyone" only means anything if the caller says which roster
 * names have already been used. Without `excludeRosterNames`, two runs that
 * never see each other's output can each independently draw the same real
 * person. Both callers query the database for names already seeded and pass
 * that set in - see DelegateSeedService.tick and the CLI script.
 */
export function generate(
  count: number,
  excludeRosterNames: ReadonlySet<string> = new Set(),
): SeedDelegate[] {
  const available = REAL_ROSTER.filter((r) => !excludeRosterNames.has(r.name));
  const rosterDraw = sample(available, available.length);
  const used = new Set<string>();
  const out: SeedDelegate[] = [];
  while (out.length < count) {
    const real = rosterDraw.pop() ?? null;
    const org = real
      ? { name: real.organisation ?? '', titles: [''] }
      : pick(ORGANISATIONS);
    const region = weightedRegion();
    const female = randomInt(100) < 62; // a gender summit skews that way
    const [realFirst, ...realRest] = real ? real.name.split(' ') : [];
    const first = real
      ? realFirst
      : pick(female ? region.first.f : region.first.m);
    const last = real ? realRest.join(' ') : pick(region.last);
    // a real name is used exactly as given; only an invented one gets an
    // invented honorific, since a title is a specific claim we cannot make
    // about a real person from a name and an organisation alone
    const honorifics = region.honorifics ?? {
      f: HONORIFICS_F,
      m: HONORIFICS_M,
    };
    const honorific =
      !real && randomInt(12) === 0
        ? pick(female ? honorifics.f : honorifics.m) + ' '
        : '';

    // Public mailboxes, the way real delegates register. Written in the
    // shapes people actually use - dots, run-together, a birth year or two
    // digits - and with a number on most of them, which is what makes a
    // collision with a real inbox unlikely rather than impossible. Anything
    // that emails delegates checks the seed tag before it sends.
    const f = slug(first);
    const l = slug(last);
    const shapes = [
      () => `${f}.${l}${randomInt(70, 99)}`,
      () => `${f}${l}${randomInt(1, 999)}`,
      () => `${f}_${l}${randomInt(19, 99)}`,
      () => `${f}.${l}`,
      () => `${l}${f}${randomInt(10, 99)}`,
    ];
    let local = pick(shapes)();
    if (used.has(local)) local = `${local}${randomInt(10, 99)}`;
    if (used.has(local)) continue;
    const domain = randomInt(10) < 7 ? 'gmail.com' : 'yahoo.com';
    used.add(local);

    // VIP is rare and never at a media house; press follows the organisation.
    // A real person gets standard only - there is no basis in this data for
    // a specific claim about their actual access tier, and VIP is not a
    // cosmetic label in this app (it gates the CEO Roundtable).
    const tier = real
      ? AccessTier.STANDARD
      : (org.tier ??
        (randomInt(40) === 0 ? AccessTier.VIP : AccessTier.STANDARD));

    out.push({
      name: `${honorific}${first} ${last}`,
      email: `${local}@${domain}`,
      // null for a real registrant, same reasoning as the tier above: no
      // specific title was given for them, so none is invented.
      title: real ? null : pick(org.titles),
      // null for every row - an organisation is a specific, checkable claim,
      // and that is true whether the name above it is invented or a real
      // registrant's. `org` is still picked above for its title and tier,
      // just never shown. Left unset (null), not filled with '' - an empty
      // string is still a value written to the column, where null is the
      // column actually being empty.
      organisation: null,
      country: null,
      accessTier: tier,
      tracks: sample(TRACKS, randomInt(1, 4)),
      interests: sample(INTERESTS, randomInt(2, 6)),
    });
  }
  return out;
}
