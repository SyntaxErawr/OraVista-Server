-- MySQL dump 10.13  Distrib 8.0.46, for Win64 (x86_64)
--
-- Host: localhost    Database: oravista_db
-- ------------------------------------------------------
-- Server version	8.0.46

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `ai_diagnostics`
--

DROP TABLE IF EXISTS `ai_diagnostics`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_diagnostics` (
  `diagnosis_id` int NOT NULL AUTO_INCREMENT,
  `patient_id` varchar(50) NOT NULL,
  `clinical_notes` text,
  `ai_findings` json DEFAULT NULL,
  `scan_date` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`diagnosis_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `ai_diagnostics`
--

LOCK TABLES `ai_diagnostics` WRITE;
/*!40000 ALTER TABLE `ai_diagnostics` DISABLE KEYS */;
/*!40000 ALTER TABLE `ai_diagnostics` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `appointments`
--

DROP TABLE IF EXISTS `appointments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `appointments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `booking_ref` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_id` int NOT NULL,
  `service_type` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `dentist_name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `appointment_date` date NOT NULL,
  `appointment_time` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `status` varchar(50) COLLATE utf8mb4_general_ci DEFAULT 'Pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `amount` decimal(10,2) DEFAULT '0.00',
  `branch` varchar(255) COLLATE utf8mb4_general_ci DEFAULT 'Main Branch',
  PRIMARY KEY (`id`),
  UNIQUE KEY `booking_ref` (`booking_ref`)
) ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `appointments`
--

LOCK TABLES `appointments` WRITE;
/*!40000 ALTER TABLE `appointments` DISABLE KEYS */;
INSERT INTO `appointments` VALUES (94,'OV - AE4D8E',80,'Oral Prophylaxis','Therese Madrid DMD','2026-05-05','11:00 AM','Pending','2026-05-04 18:10:18',1500.00,'Main Branch'),(95,'OV - 80A95F',80,'Braces Installation','Queenie Balmedina DMD','2026-05-06','01:00 PM','Pending','2026-05-04 18:10:31',35000.00,'Main Branch'),(96,'OV - 358E11',80,'Teeth Whitening','Queenie Balmedina DMD','2026-05-05','02:00 PM','Pending','2026-05-04 18:10:44',7000.00,'Main Branch'),(97,'OV - EC5CA9',80,'Wisdom Tooth Surgery','Queenie Balmedina DMD','2026-05-05','10:00 AM','Pending','2026-05-04 20:31:12',10000.00,'Main Branch'),(98,'OV - 3202A1',1,'Oral Prophylaxis','Dr. Dentist Dentist','2026-05-05','10:00 AM','Pending','2026-05-04 22:42:58',1500.00,'Main Branch');
/*!40000 ALTER TABLE `appointments` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `first_name` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `last_name` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `email` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `role` enum('patient','admin','staff','dentist') COLLATE utf8mb4_general_ci DEFAULT 'patient',
  `branch` varchar(100) COLLATE utf8mb4_general_ci DEFAULT 'Main Branch',
  `password` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sex` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `dob` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `age` int DEFAULT NULL,
  `phone` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `occupation` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `blood_type` varchar(5) COLLATE utf8mb4_general_ci DEFAULT 'O+',
  `allergies` text COLLATE utf8mb4_general_ci,
  `insurance` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `policy_number` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `specialty` varchar(100) COLLATE utf8mb4_general_ci DEFAULT 'General Dentistry',
  `status` varchar(20) COLLATE utf8mb4_general_ci DEFAULT 'Available',
  `profile_picture` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=88 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;


--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (63,'Admin','Admin','oravista2026@gmail.com','admin','Main Branch','$2b$10$tDO06r6ltNuynNQ72RpzH.tIlMV9MdEiMGDysSzUUSf3HOzVKckmy','2026-03-15 23:26:38',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'General Dentistry','Available',NULL),(64,'Staff','Staff','staff@gmail.com','staff','Main Branch','$2b$10$erew35mkSE44NUDVA/QECeiMbpa1q.53yvvemX8ZDBub7qhZ/qoja','2026-03-15 23:27:00',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'General Dentistry','Available',NULL),(65,'Dentistdada','Dentist','dentist@gmail.com','dentist','Main Branch','$2b$10$.zsj3U7nJwjwRDwBjVBnDeVy9RmoR3xRyanfILfF0t79fy/wU/5Ci','2026-03-15 23:27:20','',NULL,NULL,'','','','','','','General Dentistry','Available',NULL),(80,'Den','Lagda','lagdadenkyruss@gmail.com','patient','Gil Puyat, Pasay','$2b$10$j3rWIwoap8tPBJlt/tE46uOMf4IxFePCBQvdK8pZ.BSp6vrqwTQJu','2026-05-04 17:23:34','Male','2004-09-30',21,'09473846656','Student',NULL,NULL,NULL,NULL,'General Dentistry','Available','uploads/profile_1777915913177.png'),(81,'Therese','Madrid','therese@oravista.com','dentist','Gil Puyat, Pasay','hashedpassword123','2026-05-04 22:54:02',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'General Dentistry','Available',NULL),(82,'Queenie','Balmedina','queenie.pasay@oravista.com','dentist','Gil Puyat, Pasay','hashedpassword123','2026-05-04 22:54:02',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'Orthodontics','Available',NULL),(83,'Vicente','Epress II','vicente@oravista.com','dentist','Sta. Ana, Manila','hashedpassword123','2026-05-04 22:54:02',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'General Dentistry','Available',NULL),(84,'Carl Adrian','Usi','carl@oravista.com','dentist','Sta. Ana, Manila','hashedpassword123','2026-05-04 22:54:02',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'Restorative Treatment','Available',NULL),(85,'Queenie','Balmedina','queenie.manila@oravista.com','dentist','Sta. Ana, Manila','hashedpassword123','2026-05-04 22:54:02',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'Orthodontics','Available',NULL),(86,'Paulette','Maliit','paulette@oravista.com','dentist','Angeles, Pampanga','hashedpassword123','2026-05-04 22:54:02',NULL,NULL,NULL,NULL,NULL,'O+',NULL,NULL,NULL,'General Dentistry','Available',NULL),(87,'Dent','Lagda','dnlgdgmng@gmail.com','dentist','Gil Puyat, Pasay','$2b$10$mVJyr7jSiNaf9CthWQZYduufncS7OvQbSoBit2iobjfvgpTQUYjDK','2026-05-04 22:59:05',NULL,NULL,NULL,'1234',NULL,'O+',NULL,NULL,NULL,'Orthodontics','Available',NULL);
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;


--
-- Table structure for table `patient_records`
--

DROP TABLE IF EXISTS `patient_records`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `patient_records` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `file_name` varchar(255) NOT NULL,
  `file_path` varchar(255) NOT NULL,
  `upload_date` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `patient_records_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `patient_records`
--

LOCK TABLES `patient_records` WRITE;
/*!40000 ALTER TABLE `patient_records` DISABLE KEYS */;
/*!40000 ALTER TABLE `patient_records` ENABLE KEYS */;
UNLOCK TABLES;

-- Dump completed on 2026-05-05  8:05:19
