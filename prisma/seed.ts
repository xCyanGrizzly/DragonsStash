import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { hash } from "bcryptjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create admin user
  const adminPassword = await hash("password123", 10);
  const admin = await prisma.user.upsert({
    where: { email: "admin@dragonsstash.local" },
    update: {},
    create: {
      name: "Admin",
      email: "admin@dragonsstash.local",
      hashedPassword: adminPassword,
      role: "ADMIN",
      settings: {
        create: {
          lowStockThreshold: 10,
          currency: "USD",
          theme: "dark",
          units: "metric",
        },
      },
    },
  });

  // Create regular user
  const userPassword = await hash("password123", 10);
  const _user = await prisma.user.upsert({
    where: { email: "user@dragonsstash.local" },
    update: {},
    create: {
      name: "Demo User",
      email: "user@dragonsstash.local",
      hashedPassword: userPassword,
      role: "USER",
      settings: {
        create: {
          lowStockThreshold: 15,
          currency: "EUR",
          theme: "dark",
          units: "metric",
        },
      },
    },
  });

  // Create vendors
  const vendors = await Promise.all([
    prisma.vendor.create({
      data: {
        name: "Prusament",
        website: "https://www.prusa3d.com/category/prusament/",
        notes: "Premium filament by Prusa Research",
        userId: admin.id,
      },
    }),
    prisma.vendor.create({
      data: {
        name: "Hatchbox",
        website: "https://www.hatchbox3d.com",
        notes: "Popular budget-friendly filament brand",
        userId: admin.id,
      },
    }),
    prisma.vendor.create({
      data: {
        name: "Elegoo",
        website: "https://www.elegoo.com",
        notes: "Resin and printer manufacturer",
        userId: admin.id,
      },
    }),
    prisma.vendor.create({
      data: {
        name: "Citadel",
        website: "https://www.games-workshop.com",
        notes: "Games Workshop miniature paints",
        userId: admin.id,
      },
    }),
    prisma.vendor.create({
      data: {
        name: "Vallejo",
        website: "https://acrilicosvallejo.com",
        notes: "Professional model and miniature paints",
        userId: admin.id,
      },
    }),
  ]);

  // Create locations
  const locations = await Promise.all([
    prisma.location.create({
      data: { name: "Shelf A", description: "Main filament storage shelf", userId: admin.id },
    }),
    prisma.location.create({
      data: { name: "Shelf B", description: "Secondary storage", userId: admin.id },
    }),
    prisma.location.create({
      data: { name: "Drawer 1", description: "Paint storage drawer", userId: admin.id },
    }),
    prisma.location.create({
      data: { name: "Drawer 2", description: "Resin and accessories", userId: admin.id },
    }),
  ]);

  // Create tags
  const tags = await Promise.all([
    prisma.tag.create({ data: { name: "favorites", userId: admin.id } }),
    prisma.tag.create({ data: { name: "project-x", userId: admin.id } }),
    prisma.tag.create({ data: { name: "weathering", userId: admin.id } }),
    prisma.tag.create({ data: { name: "terrain", userId: admin.id } }),
    prisma.tag.create({ data: { name: "miniatures", userId: admin.id } }),
  ]);

  // Create filaments
  const filaments = await Promise.all([
    prisma.filament.create({
      data: {
        name: "Prusament PLA Galaxy Black",
        brand: "Prusament",
        material: "PLA",
        color: "Galaxy Black",
        colorHex: "#1a1a2e",
        spoolWeight: 1000,
        usedWeight: 350,
        cost: 29.99,
        purchaseDate: new Date("2025-11-01"),
        userId: admin.id,
        vendorId: vendors[0].id,
        locationId: locations[0].id,
        tags: { create: [{ tagId: tags[0].id }] },
      },
    }),
    prisma.filament.create({
      data: {
        name: "Hatchbox PLA True White",
        brand: "Hatchbox",
        material: "PLA",
        color: "True White",
        colorHex: "#ffffff",
        spoolWeight: 1000,
        usedWeight: 800,
        cost: 24.99,
        purchaseDate: new Date("2025-09-15"),
        userId: admin.id,
        vendorId: vendors[1].id,
        locationId: locations[0].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Prusament PETG Orange",
        brand: "Prusament",
        material: "PETG",
        color: "Orange",
        colorHex: "#f97316",
        spoolWeight: 1000,
        usedWeight: 150,
        cost: 32.99,
        purchaseDate: new Date("2025-12-01"),
        userId: admin.id,
        vendorId: vendors[0].id,
        locationId: locations[0].id,
        tags: { create: [{ tagId: tags[0].id }, { tagId: tags[1].id }] },
      },
    }),
    prisma.filament.create({
      data: {
        name: "Hatchbox ABS Red",
        brand: "Hatchbox",
        material: "ABS",
        color: "Red",
        colorHex: "#dc2626",
        spoolWeight: 1000,
        usedWeight: 50,
        cost: 22.99,
        purchaseDate: new Date("2026-01-10"),
        userId: admin.id,
        vendorId: vendors[1].id,
        locationId: locations[1].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Prusament PLA Azure Blue",
        brand: "Prusament",
        material: "PLA",
        color: "Azure Blue",
        colorHex: "#3b82f6",
        spoolWeight: 1000,
        usedWeight: 500,
        cost: 29.99,
        purchaseDate: new Date("2025-10-20"),
        userId: admin.id,
        vendorId: vendors[0].id,
        locationId: locations[0].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Hatchbox TPU Black",
        brand: "Hatchbox",
        material: "TPU",
        color: "Black",
        colorHex: "#0a0a0a",
        spoolWeight: 800,
        usedWeight: 200,
        cost: 27.99,
        purchaseDate: new Date("2025-11-15"),
        userId: admin.id,
        vendorId: vendors[1].id,
        locationId: locations[1].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Prusament PLA Lipstick Red",
        brand: "Prusament",
        material: "PLA",
        color: "Lipstick Red",
        colorHex: "#e11d48",
        spoolWeight: 1000,
        usedWeight: 950,
        cost: 29.99,
        purchaseDate: new Date("2025-08-01"),
        notes: "Almost empty, need to reorder",
        userId: admin.id,
        vendorId: vendors[0].id,
        locationId: locations[0].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Hatchbox PETG Transparent",
        brand: "Hatchbox",
        material: "PETG",
        color: "Transparent",
        colorHex: "#e2e8f0",
        spoolWeight: 1000,
        usedWeight: 100,
        cost: 25.99,
        purchaseDate: new Date("2026-01-20"),
        userId: admin.id,
        vendorId: vendors[1].id,
        locationId: locations[1].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Prusament ASA Signal Orange",
        brand: "Prusament",
        material: "ASA",
        color: "Signal Orange",
        colorHex: "#ea580c",
        spoolWeight: 850,
        usedWeight: 400,
        cost: 35.99,
        purchaseDate: new Date("2025-10-05"),
        userId: admin.id,
        vendorId: vendors[0].id,
        locationId: locations[0].id,
      },
    }),
    prisma.filament.create({
      data: {
        name: "Hatchbox PLA Silk Gold",
        brand: "Hatchbox",
        material: "PLA",
        color: "Silk Gold",
        colorHex: "#d4a017",
        spoolWeight: 1000,
        usedWeight: 250,
        cost: 26.99,
        purchaseDate: new Date("2025-12-15"),
        userId: admin.id,
        vendorId: vendors[1].id,
        locationId: locations[0].id,
        tags: { create: [{ tagId: tags[4].id }] },
      },
    }),
  ]);

  // Create resins
  const resins = await Promise.all([
    prisma.resin.create({
      data: {
        name: "Elegoo Standard Grey",
        brand: "Elegoo",
        resinType: "Standard",
        color: "Grey",
        colorHex: "#6b7280",
        bottleSize: 1000,
        usedML: 450,
        cost: 29.99,
        purchaseDate: new Date("2025-11-10"),
        userId: admin.id,
        vendorId: vendors[2].id,
        locationId: locations[3].id,
      },
    }),
    prisma.resin.create({
      data: {
        name: "Elegoo ABS-Like Clear Blue",
        brand: "Elegoo",
        resinType: "ABS-Like",
        color: "Clear Blue",
        colorHex: "#60a5fa",
        bottleSize: 500,
        usedML: 350,
        cost: 34.99,
        purchaseDate: new Date("2025-10-20"),
        userId: admin.id,
        vendorId: vendors[2].id,
        locationId: locations[3].id,
      },
    }),
    prisma.resin.create({
      data: {
        name: "Elegoo Water-Washable Ceramic Grey",
        brand: "Elegoo",
        resinType: "Water-Washable",
        color: "Ceramic Grey",
        colorHex: "#9ca3af",
        bottleSize: 1000,
        usedML: 100,
        cost: 36.99,
        purchaseDate: new Date("2026-01-05"),
        userId: admin.id,
        vendorId: vendors[2].id,
        locationId: locations[3].id,
        tags: { create: [{ tagId: tags[4].id }] },
      },
    }),
    prisma.resin.create({
      data: {
        name: "Elegoo Flexible Black",
        brand: "Elegoo",
        resinType: "Flexible",
        color: "Black",
        colorHex: "#171717",
        bottleSize: 500,
        usedML: 480,
        cost: 39.99,
        purchaseDate: new Date("2025-09-01"),
        notes: "Nearly empty",
        userId: admin.id,
        vendorId: vendors[2].id,
        locationId: locations[3].id,
      },
    }),
    prisma.resin.create({
      data: {
        name: "Elegoo Tough White",
        brand: "Elegoo",
        resinType: "Tough",
        color: "White",
        colorHex: "#f5f5f5",
        bottleSize: 1000,
        usedML: 200,
        cost: 42.99,
        purchaseDate: new Date("2025-12-20"),
        userId: admin.id,
        vendorId: vendors[2].id,
        locationId: locations[3].id,
      },
    }),
  ]);

  // Create paints
  const paints = await Promise.all([
    prisma.paint.create({
      data: {
        name: "Abaddon Black",
        brand: "Citadel",
        line: "Base",
        color: "Black",
        colorHex: "#231f20",
        finish: "Matte",
        volumeML: 12,
        usedML: 6,
        cost: 5.49,
        purchaseDate: new Date("2025-10-01"),
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
        tags: { create: [{ tagId: tags[4].id }] },
      },
    }),
    prisma.paint.create({
      data: {
        name: "Mephiston Red",
        brand: "Citadel",
        line: "Base",
        color: "Red",
        colorHex: "#9a1115",
        finish: "Matte",
        volumeML: 12,
        usedML: 3,
        cost: 5.49,
        purchaseDate: new Date("2025-10-01"),
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
      },
    }),
    prisma.paint.create({
      data: {
        name: "Retributor Armour",
        brand: "Citadel",
        line: "Base",
        color: "Gold",
        colorHex: "#c39e5a",
        finish: "Metallic",
        volumeML: 12,
        usedML: 8,
        cost: 5.49,
        purchaseDate: new Date("2025-09-15"),
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
      },
    }),
    prisma.paint.create({
      data: {
        name: "Nuln Oil",
        brand: "Citadel",
        line: "Shade",
        color: "Black",
        colorHex: "#14120e",
        finish: "Wash",
        volumeML: 24,
        usedML: 10,
        cost: 7.99,
        purchaseDate: new Date("2025-10-01"),
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
        tags: { create: [{ tagId: tags[2].id }] },
      },
    }),
    prisma.paint.create({
      data: {
        name: "Agrax Earthshade",
        brand: "Citadel",
        line: "Shade",
        color: "Brown",
        colorHex: "#4b3620",
        finish: "Wash",
        volumeML: 24,
        usedML: 15,
        cost: 7.99,
        purchaseDate: new Date("2025-08-20"),
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
        tags: { create: [{ tagId: tags[2].id }, { tagId: tags[3].id }] },
      },
    }),
    prisma.paint.create({
      data: {
        name: "Model Color White",
        brand: "Vallejo",
        line: "Model Color",
        color: "White",
        colorHex: "#f8f8f8",
        finish: "Matte",
        volumeML: 17,
        usedML: 5,
        cost: 3.99,
        purchaseDate: new Date("2025-11-01"),
        userId: admin.id,
        vendorId: vendors[4].id,
        locationId: locations[2].id,
      },
    }),
    prisma.paint.create({
      data: {
        name: "Model Color German Grey",
        brand: "Vallejo",
        line: "Model Color",
        color: "German Grey",
        colorHex: "#4a4a4a",
        finish: "Matte",
        volumeML: 17,
        usedML: 2,
        cost: 3.99,
        purchaseDate: new Date("2025-11-01"),
        userId: admin.id,
        vendorId: vendors[4].id,
        locationId: locations[2].id,
      },
    }),
    prisma.paint.create({
      data: {
        name: "Contrast Blood Angels Red",
        brand: "Citadel",
        line: "Contrast",
        color: "Red",
        colorHex: "#c01411",
        finish: "Contrast",
        volumeML: 18,
        usedML: 12,
        cost: 7.99,
        purchaseDate: new Date("2025-09-10"),
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
      },
    }),
    prisma.paint.create({
      data: {
        name: "Leadbelcher",
        brand: "Citadel",
        line: "Base",
        color: "Silver",
        colorHex: "#a8a8a8",
        finish: "Metallic",
        volumeML: 12,
        usedML: 11,
        cost: 5.49,
        purchaseDate: new Date("2025-07-01"),
        notes: "Almost empty, reorder soon",
        userId: admin.id,
        vendorId: vendors[3].id,
        locationId: locations[2].id,
      },
    }),
    prisma.paint.create({
      data: {
        name: "Surface Primer Black",
        brand: "Vallejo",
        line: "Surface Primer",
        color: "Black",
        colorHex: "#1a1a1a",
        finish: "Primer",
        volumeML: 60,
        usedML: 20,
        cost: 9.99,
        purchaseDate: new Date("2025-12-01"),
        userId: admin.id,
        vendorId: vendors[4].id,
        locationId: locations[2].id,
      },
    }),
  ]);

  // Create some usage logs
  await Promise.all([
    prisma.usageLog.create({
      data: {
        itemType: "FILAMENT",
        itemId: filaments[0].id,
        filamentId: filaments[0].id,
        amount: 50,
        unit: "g",
        notes: "Printed phone stand",
        userId: admin.id,
      },
    }),
    prisma.usageLog.create({
      data: {
        itemType: "FILAMENT",
        itemId: filaments[2].id,
        filamentId: filaments[2].id,
        amount: 100,
        unit: "g",
        notes: "Printed enclosure parts",
        userId: admin.id,
      },
    }),
    prisma.usageLog.create({
      data: {
        itemType: "RESIN",
        itemId: resins[0].id,
        resinId: resins[0].id,
        amount: 150,
        unit: "ml",
        notes: "Printed miniature batch",
        userId: admin.id,
      },
    }),
    prisma.usageLog.create({
      data: {
        itemType: "PAINT",
        itemId: paints[0].id,
        paintId: paints[0].id,
        amount: 2,
        unit: "ml",
        notes: "Base coated 5 miniatures",
        userId: admin.id,
      },
    }),
    prisma.usageLog.create({
      data: {
        itemType: "PAINT",
        itemId: paints[3].id,
        paintId: paints[3].id,
        amount: 3,
        unit: "ml",
        notes: "Washed batch of 10 infantry",
        userId: admin.id,
      },
    }),
  ]);

  console.log("Database seeded successfully!");
  console.log(`  Admin: admin@dragonsstash.local / password123`);
  console.log(`  User:  user@dragonsstash.local / password123`);
  console.log(`  Vendors: ${vendors.length}`);
  console.log(`  Locations: ${locations.length}`);
  console.log(`  Filaments: ${filaments.length}`);
  console.log(`  Resins: ${resins.length}`);
  console.log(`  Paints: ${paints.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
