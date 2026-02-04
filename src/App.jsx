import React from 'react';
import './styles/index.css';

// Assets
import wvdiLogo from './assets/WVDI-logo.png';
import ltoAccredited from './assets/LTO-accredited.webp';
import bestSeal from './assets/Best-Company-high-res-seal-small-768x768.webp';
import trophyWebp from './assets/Trophy.webp';

// Layout Components
import Header from './components/layout/Header';
import Footer from './components/layout/Footer';

// Section Components
import Carousel from './Carousel.jsx';
import Seo from './Seo.jsx';
import InstructorSection from './components/instructors/InstructorSection';
import PackagesSection from './components/courses/PackagesSection';
import BranchesSection from './components/sections/BranchesSection';
import GallerySection from './components/sections/GallerySection';
import ContactSection from './components/sections/ContactSection';
import FAQSection from './components/sections/FAQSection';
import TestimonialsSection from './components/sections/TestimonialsSection';
import WhyChooseUsSection from './components/sections/WhyChooseUsSection';

// UI Components
import MobileStickyCTA from './components/ui/MobileStickyCTA';
import DriveBotWidget from './DriveBotWidget';
import MessengerChat from './MessengerChat';

// Config
import config from './data/config.json';

function App() {
  const { seo } = config;

  return (
    <>
      <Seo
        title={seo.title}
        description={seo.description}
        image={seo.image}
        locale={seo.locale}
      />
      <div className="wvdi-root">
        <Header logo={wvdiLogo} />

        <main>
          <section id="home" className="wvdi-hero">
            <h2>Your Trusted Driving Education Partner</h2>
            <p>Get professional driving training from LTO-accredited instructors on Negros Island.</p>
            <a href="#contact" className="wvdi-cta">Enroll Now</a>
            <Carousel />
          </section>

          <section id="about" className="wvdi-accreditation">
            <h2>About WVDI</h2>
            <div className="wvdi-instructor-gallery">
              <img src={ltoAccredited} alt="LTO Accredited" />
              <img src={bestSeal} alt="Best Company Seal" />
              <img src={trophyWebp} alt="Trophy" />
            </div>
            <p>
              WVDI Corp. is an LTO accredited driving school which has evolved to become the first
              driving school to offer comprehensive packages including FREE class lectures on
              Defensive Driving, Preventive Maintenance, Site Lectures and Hands-On Car Maintenance.
            </p>
            <a href="#courses" className="wvdi-cta">View Our Courses</a>
          </section>

          <WhyChooseUsSection />
          <TestimonialsSection />
          <InstructorSection />

          <div id="courses" className="scroll-mt-24"></div>
          <PackagesSection />

          <BranchesSection />
          <GallerySection />
          <FAQSection />
          <ContactSection />
        </main>

        <Footer />
        <MobileStickyCTA />
        <DriveBotWidget />
        <MessengerChat />
      </div>
    </>
  );
}

export default App;
